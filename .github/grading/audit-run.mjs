#!/usr/bin/env node
/**
 * Continuous audit run driver.
 *
 * Spec: https://github.com/marcelsud/specs/blob/main/continuous-audit.md (1.1.0)
 *
 * The loop is agent-driven (§10.1): the agent is the top-level process and
 * invokes this tool for every deterministic step.
 *
 *   start   select the topic, open the run
 *   check   fingerprint, deduplicate, verify the reproduction, grade
 *   file    create the issue for a candidate that passed check
 *   finish  append the ledger entries and close the run
 *
 * §10.3: the agent decides what to examine and what to claim; this tool decides
 * what is allowed to leave the machine. Every externally observable effect is
 * gated on state recorded here, never on anything the agent asserts.
 */
import { execFileSync, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parse as parseYaml } from "yaml"
import { validateIssueRecord } from "./checks.mjs"
import {
  AuditFailure,
  churnSince,
  fingerprint,
  loadTopics,
  readLedger,
  selectTopic,
  selectableTopics,
  validateFindingEntry,
  validateRunEntry,
} from "./audit.mjs"

const LEDGER_BRANCH = "grading-ledger"
const DEFAULT_CONFIG = ".github/grading/config.yml"
const REPRODUCTION_TIMEOUT_MS = 10 * 60 * 1000

const git = (args, cwd) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()

/* -------------------------------------------------------------- run state */

/**
 * Untracked, inside .git so it can never be committed and never appears in
 * `git status`. This is the state §10.3 requires `file` to consult and §10.4
 * requires `start` to inspect for abandonment.
 */
const statePath = (cwd) => path.join(git(["rev-parse", "--git-dir"], cwd), "continuous-audit-run.json")

const readState = (cwd) => {
  const file = statePath(cwd)
  if (!fs.existsSync(file)) return null
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    throw new AuditFailure(`run state at ${file} is unreadable; remove it to recover`)
  }
}

const writeState = (cwd, state) =>
  fs.writeFileSync(statePath(cwd), `${JSON.stringify(state, null, 2)}\n`)

const clearState = (cwd) => fs.rmSync(statePath(cwd), { force: true })

const requireState = (cwd) => {
  const state = readState(cwd)
  if (!state) throw new AuditFailure("no run is open; run `audit-run.mjs start` first")
  return state
}

/* --------------------------------------------------------------- candidate */

/**
 * A candidate is the proposed issue body. It carries the §5.4 grading record
 * that checks.mjs already parses, plus one `audit_candidate` block holding what
 * fingerprinting and reproduction need.
 */
export const parseCandidate = (markdown) => {
  const blocks = [...markdown.matchAll(/```ya?ml\n([\s\S]*?)```/g)].map((match) => match[1])
  let candidate = null
  for (const block of blocks) {
    const parsed = parseYaml(block)
    if (parsed && typeof parsed === "object" && parsed.audit_candidate) {
      candidate = parsed.audit_candidate
      break
    }
  }
  if (!candidate) throw new AuditFailure("candidate lacks an `audit_candidate:` yaml block")

  for (const field of ["path", "consequence_category", "normalized_claim", "reproduction"]) {
    if (!candidate[field]) throw new AuditFailure(`audit_candidate requires ${field}`)
  }
  const command = candidate.reproduction.command
  if (!Array.isArray(command) || command.length === 0) {
    throw new AuditFailure("audit_candidate.reproduction.command must be a non-empty array")
  }
  return candidate
}

/* ------------------------------------------------------- reproduction gate */

/**
 * §7.2: this tool runs the reproduction itself and requires it to FAIL at the
 * audited commit. An agent transcript is a claim about a reproduction, not the
 * reproduction. A command that succeeds demonstrates working software.
 */
export const verifyReproduction = ({ command, cwd, timeoutMs = REPRODUCTION_TIMEOUT_MS }) => {
  const [file, ...args] = command
  const result = spawnSync(file, args, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
  })

  if (result.error?.code === "ETIMEDOUT" || result.signal) {
    return { reproduced: false, reason: `reproduction did not settle within ${timeoutMs}ms` }
  }
  if (result.error) {
    return { reproduced: false, reason: `reproduction could not run: ${result.error.message}` }
  }
  if (result.status === 0) {
    return { reproduced: false, reason: "reproduction succeeded at the audited commit" }
  }
  return {
    reproduced: true,
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().slice(-4000),
  }
}

/* ------------------------------------------------------------------ ledger */

const withLedgerWorktree = (cwd, callback) => {
  const worktree = path.join(os.tmpdir(), `audit-ledger-${process.pid}-${Date.now()}`)
  git(["fetch", "--quiet", "origin", LEDGER_BRANCH], cwd)
  git(["worktree", "add", "--quiet", "--detach", worktree, `origin/${LEDGER_BRANCH}`], cwd)
  try {
    return callback(worktree)
  } finally {
    try {
      git(["worktree", "remove", "--force", worktree], cwd)
    } catch {
      fs.rmSync(worktree, { recursive: true, force: true })
    }
  }
}

const appendLedger = ({ cwd, runEntry, findingEntries, dryRun }) => {
  const lines = {
    "topics.jsonl": `${JSON.stringify(runEntry)}\n`,
    "findings.jsonl": findingEntries.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
  }

  if (dryRun) {
    process.stderr.write("--- would append to topics.jsonl ---\n" + lines["topics.jsonl"])
    if (lines["findings.jsonl"]) {
      process.stderr.write("--- would append to findings.jsonl ---\n" + lines["findings.jsonl"])
    }
    return { pushed: false }
  }

  return withLedgerWorktree(cwd, (worktree) => {
    for (const [file, content] of Object.entries(lines)) {
      if (content) fs.appendFileSync(path.join(worktree, file), content)
    }
    git(["add", "-A"], worktree)
    git(["commit", "-q", "-m", `chore(audit): record run ${runEntry.run_id}`], worktree)
    git(["push", "--quiet", "origin", `HEAD:${LEDGER_BRANCH}`], worktree)
    return { pushed: true }
  })
}

/* ------------------------------------------------------------------ issues */

const createIssue = ({ title, bodyFile, labels, cwd }) => {
  const args = ["issue", "create", "--title", title, "--body-file", bodyFile]
  for (const label of labels) args.push("--label", label)
  const url = execFileSync("gh", args, { cwd, encoding: "utf8" }).trim().split("\n").pop()
  return { url, number: Number(url.split("/").pop()) }
}

/* --------------------------------------------------------------- commands */

const nowId = (cwd) => `${git(["rev-parse", "--short", "HEAD"], cwd)}-${process.pid}`

const cmdStart = ({ cwd, configFile, seedArg }) => {
  const abandoned = readState(cwd)
  let recovered = null

  // §10.4: a run that started and never finished MUST be recorded as failed
  // before another opens. Recording it as completed would mark its topic
  // audited and silently open a permanent coverage hole.
  if (abandoned) {
    const runEntry = validateRunEntry({
      topic_id: abandoned.topic_id,
      run_id: abandoned.run_id,
      commit_audited: abandoned.commit_audited,
      seed: abandoned.seed,
      outcome: "failed",
      reason: "run abandoned; recovered by a later start",
    })
    appendLedger({ cwd, runEntry, findingEntries: [], dryRun: false })
    clearState(cwd)
    recovered = abandoned.run_id
  }

  const { topics, objectives } = loadTopics(configFile)
  const eligible = selectableTopics({ topics, objectives })
  if (eligible.length === 0) throw new AuditFailure("no topic cites a registered objective")

  try {
    git(["fetch", "--quiet", "origin", LEDGER_BRANCH], cwd)
  } catch {
    // No remote, or no ledger branch yet: fall back to whatever is local.
  }
  const { runs, findings } = readLedger({ cwd })
  const seed = seedArg === undefined ? Math.floor(Math.random() * 2 ** 32) : Number(seedArg)
  const { selected } = selectTopic({
    topics: eligible,
    runs,
    seed,
    churnOf: (topic, since) => churnSince({ paths: topic.paths, sinceCommit: since, cwd }),
  })

  const commit = git(["rev-parse", "HEAD"], cwd)
  const state = {
    run_id: nowId(cwd),
    topic_id: selected.id,
    commit_audited: commit,
    seed,
    checked: [],
  }
  writeState(cwd, state)

  return {
    recovered_run: recovered,
    run_id: state.run_id,
    topic: selected,
    seed,
    commit,
    skipped_topics: topics.length - eligible.length,
    // Supplied so the agent can avoid re-proposing what the ledger already holds.
    known_fingerprints: findings
      .filter((entry) => entry.topic_id === selected.id)
      .map((entry) => ({
        fingerprint: entry.fingerprint,
        path: entry.path,
        claim: entry.normalized_claim,
        disposition: entry.disposition,
      })),
  }
}

const cmdCheck = async ({ cwd, candidateFile }) => {
  const state = requireState(cwd)
  const markdown = fs.readFileSync(candidateFile, "utf8")
  const candidate = parseCandidate(markdown)

  const print = await fingerprint({
    path: candidate.path,
    consequenceCategory: candidate.consequence_category,
    normalizedClaim: candidate.normalized_claim,
  })

  const base = {
    fingerprint: print,
    topic_id: state.topic_id,
    run_id: state.run_id,
    commit_audited: state.commit_audited,
    path: candidate.path,
    consequence_category: candidate.consequence_category,
    normalized_claim: candidate.normalized_claim,
  }

  try {
    git(["fetch", "--quiet", "origin", LEDGER_BRANCH], cwd)
  } catch {
    // No remote: read whatever is local.
  }
  const { findings } = readLedger({ cwd })

  // §8.2 stage one: an exact fingerprint match is a duplicate, recorded without
  // further work. Deduplication precedes reproduction because reproduction is
  // the most expensive stage.
  const exact = findings.find((entry) => entry.fingerprint === print)
  if (exact) {
    const result = { ...base, disposition: "duplicate", reason: `matches ${print.slice(0, 12)}` }
    state.checked.push({ ...result, verified: false })
    writeState(cwd, state)
    return result
  }

  // §8.2 stage two: same path and category but a different fingerprint needs
  // adjudication before filing. Reported, not auto-rejected.
  const related = findings.filter(
    (entry) =>
      entry.path === candidate.path && entry.consequence_category === candidate.consequence_category,
  )

  const reproduction = verifyReproduction({ command: candidate.reproduction.command, cwd })
  if (!reproduction.reproduced) {
    const result = { ...base, disposition: "unproven", reason: reproduction.reason }
    state.checked.push({ ...result, verified: false })
    writeState(cwd, state)
    return result
  }

  let grade
  try {
    grade = validateIssueRecord(markdown).grade
  } catch (error) {
    const result = { ...base, disposition: "ineligible", reason: error.message }
    state.checked.push({ ...result, verified: false })
    writeState(cwd, state)
    return result
  }

  const result = {
    ...base,
    disposition: "filed",
    grade,
    reproduction_status: reproduction.status,
    reproduction_output: reproduction.output,
    needs_adjudication: related.map((entry) => entry.fingerprint),
  }
  state.checked.push({ ...result, verified: true })
  writeState(cwd, state)
  return result
}

const cmdFile = async ({ cwd, candidateFile, dryRun }) => {
  const state = requireState(cwd)
  const markdown = fs.readFileSync(candidateFile, "utf8")
  const candidate = parseCandidate(markdown)
  const print = await fingerprint({
    path: candidate.path,
    consequenceCategory: candidate.consequence_category,
    normalizedClaim: candidate.normalized_claim,
  })

  // §10.3: refuse anything that did not pass `check` within THIS run, decided
  // from state this tool wrote. An agent that skipped verification is
  // indistinguishable from one that did, unless the gate reads its own record.
  const checked = state.checked.find((entry) => entry.fingerprint === print && entry.verified)
  if (!checked) {
    throw new AuditFailure(
      `candidate ${print.slice(0, 12)} has not passed check in run ${state.run_id}; run check first`,
    )
  }
  if (checked.issue) throw new AuditFailure(`candidate ${print.slice(0, 12)} was already filed`)

  const title = candidate.title ?? markdown.match(/^#\s+(.+)$/m)?.[1]
  if (!title) throw new AuditFailure("candidate needs a title, as `audit_candidate.title` or an H1")

  if (dryRun) {
    process.stderr.write(`--- would file ---\n${title}\n`)
    return { filed: false, title }
  }

  const issue = createIssue({
    title,
    bodyFile: candidateFile,
    labels: ["bug", "grading:eligible", `issue-grade:${checked.grade}`],
    cwd,
  })
  checked.issue = issue.number
  writeState(cwd, state)
  return { filed: true, title, ...issue }
}

/**
 * Resolve a verified candidate without filing it. §8.2 stage two: a candidate
 * sharing path and category with a prior entry needs adjudication, and the
 * outcome may be that it is the same root cause after all.
 */
const cmdDrop = async ({ cwd, candidateFile, disposition, reason }) => {
  const state = requireState(cwd)
  if (!reason) throw new AuditFailure("drop requires --reason")

  const candidate = parseCandidate(fs.readFileSync(candidateFile, "utf8"))
  const print = await fingerprint({
    path: candidate.path,
    consequenceCategory: candidate.consequence_category,
    normalizedClaim: candidate.normalized_claim,
  })

  const checked = state.checked.find((entry) => entry.fingerprint === print)
  if (!checked) throw new AuditFailure(`candidate ${print.slice(0, 12)} has not passed check`)
  if (checked.issue) throw new AuditFailure(`candidate ${print.slice(0, 12)} was already filed`)

  checked.dropped = { disposition, reason }
  writeState(cwd, state)
  return { dropped: print, disposition, reason }
}

const cmdFinish = ({ cwd, dryRun }) => {
  const state = requireState(cwd)

  // A verified candidate must be resolved before the run closes: filed, or
  // dropped with a reason. Inventing a disposition here would put an unexamined
  // conclusion in the ledger, and §8.3 keys re-eligibility on that conclusion.
  const unresolved = state.checked.filter((entry) => entry.verified && !entry.issue && !entry.dropped)
  if (unresolved.length > 0) {
    throw new AuditFailure(
      `${unresolved.length} verified candidate(s) neither filed nor dropped: ` +
        `${unresolved.map((entry) => entry.fingerprint.slice(0, 12)).join(", ")}. ` +
        "Use `file` or `drop --disposition <d> --reason <why>` on each.",
    )
  }

  const findingEntries = state.checked.map((entry) =>
    validateFindingEntry({
      fingerprint: entry.fingerprint,
      topic_id: entry.topic_id,
      run_id: entry.run_id,
      commit_audited: entry.commit_audited,
      path: entry.path,
      consequence_category: entry.consequence_category,
      normalized_claim: entry.normalized_claim,
      disposition: entry.issue ? "filed" : entry.dropped?.disposition ?? entry.disposition,
      ...(entry.issue ? { issue: entry.issue } : {}),
      ...(entry.dropped ? { reason: entry.dropped.reason } : entry.reason ? { reason: entry.reason } : {}),
    }),
  )

  const dispositions = {}
  for (const entry of findingEntries) {
    dispositions[entry.disposition] = (dispositions[entry.disposition] ?? 0) + 1
  }

  const runEntry = validateRunEntry({
    topic_id: state.topic_id,
    run_id: state.run_id,
    commit_audited: state.commit_audited,
    seed: state.seed,
    outcome: "completed",
    candidates: findingEntries.length,
    filed: dispositions.filed ?? 0,
    dispositions,
  })

  const { pushed } = appendLedger({ cwd, runEntry, findingEntries, dryRun })
  if (!dryRun) clearState(cwd)
  return { run: runEntry, findings: findingEntries.length, pushed }
}

/* -------------------------------------------------------------------- CLI */

const option = (args, name) => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

const runCli = async () => {
  const [command, ...args] = process.argv.slice(2)
  const cwd = process.cwd()
  const dryRun = args.includes("--dry-run")
  const emit = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)

  if (command === "start") {
    emit(cmdStart({ cwd, configFile: option(args, "--config") ?? DEFAULT_CONFIG, seedArg: option(args, "--seed") }))
    return
  }
  if (command === "check") {
    emit(await cmdCheck({ cwd, candidateFile: args[0] }))
    return
  }
  if (command === "file") {
    emit(await cmdFile({ cwd, candidateFile: args[0], dryRun }))
    return
  }
  if (command === "drop") {
    emit(
      await cmdDrop({
        cwd,
        candidateFile: args[0],
        disposition: option(args, "--disposition") ?? "duplicate",
        reason: option(args, "--reason"),
      }),
    )
    return
  }
  if (command === "finish") {
    emit(cmdFinish({ cwd, dryRun }))
    return
  }
  if (command === "status") {
    emit(readState(cwd) ?? { open: false })
    return
  }

  throw new AuditFailure("usage: audit-run.mjs <start|check|file|drop|finish|status> [--dry-run]")
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  runCli().catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}
