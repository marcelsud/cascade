import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { AuditFailure } from "./audit.mjs"
import { parseCandidate, verifyReproduction } from "./audit-run.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RUNNER = path.join(HERE, "audit-run.mjs")

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()

const write = (cwd, file, content) => {
  const target = path.join(cwd, file)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, content)
  return target
}

/** Runs the CLI the way an agent would. Returns { status, stdout, stderr }. */
const run = (cwd, ...args) => {
  const result = execFileSync("node", [RUNNER, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
  return JSON.parse(result)
}

const runExpectingFailure = (cwd, ...args) => {
  try {
    execFileSync("node", [RUNNER, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    throw new Error("expected the command to fail")
  } catch (error) {
    if (!error.stderr && !error.status) throw error
    return `${error.stderr ?? ""}`
  }
}

const CONFIG = `rubric_version: 1.1.0
objectives:
  REL-1: delivery guarantees
topics:
  - id: alpha
    paths: [src/]
    objectives: [REL-1]
`

const eligibility = Array.from(
  { length: 9 },
  (_, index) => `  IE-${index + 1}: { answer: yes, evidence: "Evidence ${index + 1}" }`,
).join("\n")

/**
 * A conforming candidate: the proposed issue body carrying the §5.4 grading
 * record plus the audit_candidate block.
 */
const candidate = ({ claim = "unbounded buffer", command, grade = "A", rule = "A-blocker", severity = "blocker" }) => `# Something is wrong

\`\`\`yaml
audit_candidate:
  path: src/alpha.ts
  consequence_category: reliability
  normalized_claim: ${claim}
  reproduction:
    command: ${JSON.stringify(command)}
\`\`\`

## Grading record

\`\`\`yaml
rubric_version: 1.1.0
eligibility:
${eligibility}
severity: ${severity}
value_rule: ${rule}
issue_grade: ${grade}
grade_rationale: Direct evidence changes the release decision. Rule ${rule} applies.
\`\`\`
`

/** A repo with a ledger branch, so the runner has something to read and push to. */
const withProject = (callback) => {
  const root = mkdtempSync(path.join(tmpdir(), "audit-run-"))
  const remote = path.join(root, "remote.git")
  const cwd = path.join(root, "work")

  try {
    execFileSync("git", ["init", "-q", "--bare", remote])
    execFileSync("git", ["clone", "-q", remote, cwd])
    git(cwd, "config", "user.name", "Audit Run Tests")
    git(cwd, "config", "user.email", "audit-run-tests@example.invalid")

    write(cwd, ".github/grading/config.yml", CONFIG)
    write(cwd, "src/alpha.ts", "export const alpha = 1\n")
    git(cwd, "add", ".")
    git(cwd, "commit", "-q", "-m", "baseline")
    const branch = git(cwd, "rev-parse", "--abbrev-ref", "HEAD")
    git(cwd, "push", "-q", "origin", branch)

    // Ledger branch, as the real project has. The orphan checkout leaves the
    // source files untracked, so remove them before switching back or git
    // refuses to overwrite them.
    git(cwd, "checkout", "-q", "--orphan", "grading-ledger")
    git(cwd, "rm", "-rq", "--cached", ".")
    rmSync(path.join(cwd, ".github"), { recursive: true, force: true })
    rmSync(path.join(cwd, "src"), { recursive: true, force: true })
    write(cwd, "topics.jsonl", "")
    write(cwd, "findings.jsonl", "")
    git(cwd, "add", "topics.jsonl", "findings.jsonl")
    git(cwd, "commit", "-q", "-m", "ledger")
    git(cwd, "push", "-q", "origin", "grading-ledger")
    git(cwd, "checkout", "-qf", branch)

    return callback({ cwd, remote })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const ledgerLines = (cwd, file) =>
  git(cwd, "show", `origin/grading-ledger:${file}`)
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))

const FAILING = ["node", "-e", "process.exit(1)"]
const PASSING = ["node", "-e", "process.exit(0)"]

/* -------------------------------------------------------------- candidate */

test("parseCandidate requires the audit_candidate block and a command array", () => {
  assert.throws(() => parseCandidate("# no yaml here"), /audit_candidate/)
  assert.throws(
    () => parseCandidate("```yaml\naudit_candidate:\n  path: a\n```"),
    /requires consequence_category/,
  )
  const parsed = parseCandidate(candidate({ command: FAILING }))
  assert.equal(parsed.path, "src/alpha.ts")
  assert.deepEqual(parsed.reproduction.command, FAILING)
})

/* ------------------------------------------------------- reproduction gate */

// §7.2: the reproduction MUST fail at the audited commit. A command that
// succeeds demonstrates working software, not a defect.
test("verifyReproduction accepts failure and rejects success", () => {
  assert.equal(verifyReproduction({ command: FAILING, cwd: HERE }).reproduced, true)
  const passed = verifyReproduction({ command: PASSING, cwd: HERE })
  assert.equal(passed.reproduced, false)
  assert.match(passed.reason, /succeeded/)
})

test("verifyReproduction rejects a command that cannot run", () => {
  const result = verifyReproduction({ command: ["definitely-not-a-real-binary-xyz"], cwd: HERE })
  assert.equal(result.reproduced, false)
  assert.match(result.reason, /could not run/)
})

test("verifyReproduction rejects a command that does not settle", () => {
  const result = verifyReproduction({
    command: ["node", "-e", "setTimeout(() => {}, 60000)"],
    cwd: HERE,
    timeoutMs: 300,
  })
  assert.equal(result.reproduced, false)
  assert.match(result.reason, /did not settle/)
})

/* ------------------------------------------------------------ run lifecycle */

test("start opens a run and reports the selected topic", () =>
  withProject(({ cwd }) => {
    const started = run(cwd, "start", "--seed", "1")
    assert.equal(started.topic.id, "alpha")
    assert.equal(started.recovered_run, null)
    assert.ok(started.run_id)
    assert.equal(run(cwd, "status").topic_id, "alpha")
  }))

test("check refuses to run before start", () =>
  withProject(({ cwd }) => {
    write(cwd, "candidate.md", candidate({ command: FAILING }))
    assert.match(runExpectingFailure(cwd, "check", "candidate.md"), /no run is open/)
  }))

test("a reproduced, well-graded candidate is verified and filable", () =>
  withProject(({ cwd }) => {
    run(cwd, "start", "--seed", "1")
    write(cwd, "candidate.md", candidate({ command: FAILING }))
    const checked = run(cwd, "check", "candidate.md")
    assert.equal(checked.disposition, "filed")
    assert.equal(checked.grade, "A")
    assert.equal(run(cwd, "file", "candidate.md", "--dry-run").filed, false)
  }))

// §7.2: a candidate whose reproduction succeeds is unproven and never filed.
test("a candidate whose reproduction succeeds is unproven and unfilable", () =>
  withProject(({ cwd }) => {
    run(cwd, "start", "--seed", "1")
    write(cwd, "candidate.md", candidate({ command: PASSING }))
    assert.equal(run(cwd, "check", "candidate.md").disposition, "unproven")
    assert.match(runExpectingFailure(cwd, "file", "candidate.md"), /has not passed check/)
  }))

test("a candidate failing the grading gate is ineligible and unfilable", () =>
  withProject(({ cwd }) => {
    run(cwd, "start", "--seed", "1")
    // issue_grade contradicts value_rule, which checks.mjs rejects.
    write(cwd, "candidate.md", candidate({ command: FAILING, grade: "A", rule: "B-localized-material", severity: "material" }))
    const checked = run(cwd, "check", "candidate.md")
    assert.equal(checked.disposition, "ineligible")
    assert.match(runExpectingFailure(cwd, "file", "candidate.md"), /has not passed check/)
  }))

// §10.3: the gate reads state this tool wrote, not anything the agent asserts.
test("file refuses a candidate that never passed check in this run", () =>
  withProject(({ cwd }) => {
    run(cwd, "start", "--seed", "1")
    write(cwd, "candidate.md", candidate({ command: FAILING }))
    assert.match(runExpectingFailure(cwd, "file", "candidate.md"), /has not passed check/)
  }))

test("finish refuses while a verified candidate is neither filed nor dropped", () =>
  withProject(({ cwd }) => {
    run(cwd, "start", "--seed", "1")
    write(cwd, "candidate.md", candidate({ command: FAILING }))
    run(cwd, "check", "candidate.md")
    assert.match(runExpectingFailure(cwd, "finish"), /neither filed nor dropped/)
  }))

// §8.2 stage two: adjudication may conclude the candidate is a known finding.
test("drop resolves a verified candidate with a recorded reason", () =>
  withProject(({ cwd }) => {
    run(cwd, "start", "--seed", "1")
    write(cwd, "candidate.md", candidate({ command: FAILING }))
    run(cwd, "check", "candidate.md")
    run(cwd, "drop", "candidate.md", "--disposition", "duplicate", "--reason", "same root cause as #1")

    const finished = run(cwd, "finish")
    assert.equal(finished.run.outcome, "completed")
    const findings = ledgerLines(cwd, "findings.jsonl")
    assert.equal(findings.length, 1)
    assert.equal(findings[0].disposition, "duplicate")
    assert.equal(findings[0].reason, "same root cause as #1")
  }))

test("drop requires a reason", () =>
  withProject(({ cwd }) => {
    run(cwd, "start", "--seed", "1")
    write(cwd, "candidate.md", candidate({ command: FAILING }))
    run(cwd, "check", "candidate.md")
    assert.match(runExpectingFailure(cwd, "drop", "candidate.md"), /requires --reason/)
  }))

test("finish records a dry run and closes it", () =>
  withProject(({ cwd }) => {
    const started = run(cwd, "start", "--seed", "1")
    const finished = run(cwd, "finish")

    assert.equal(finished.run.outcome, "completed")
    assert.equal(finished.findings, 0)
    const runs = ledgerLines(cwd, "topics.jsonl")
    assert.equal(runs.length, 1)
    assert.equal(runs[0].run_id, started.run_id)
    assert.deepEqual(run(cwd, "status"), { open: false })
  }))

// §8.2 stage one: an exact fingerprint match is a duplicate, dropped before the
// expensive reproduction stage.
test("a fingerprint already in the ledger is a duplicate without reproducing", () =>
  withProject(({ cwd }) => {
    run(cwd, "start", "--seed", "1")
    write(cwd, "candidate.md", candidate({ command: FAILING }))
    run(cwd, "check", "candidate.md")
    run(cwd, "drop", "candidate.md", "--disposition", "not-current", "--reason", "already fixed")
    run(cwd, "finish")

    run(cwd, "start", "--seed", "1")
    // A reproduction that would pass: if it ran, the candidate would be
    // 'unproven'. Getting 'duplicate' proves deduplication came first.
    write(cwd, "candidate.md", candidate({ command: PASSING }))
    assert.equal(run(cwd, "check", "candidate.md").disposition, "duplicate")
  }))

test("start reports prior fingerprints for the selected topic", () =>
  withProject(({ cwd }) => {
    run(cwd, "start", "--seed", "1")
    write(cwd, "candidate.md", candidate({ command: FAILING }))
    run(cwd, "check", "candidate.md")
    run(cwd, "drop", "candidate.md", "--disposition", "unproven", "--reason", "not demonstrated")
    run(cwd, "finish")

    const started = run(cwd, "start", "--seed", "1")
    assert.equal(started.known_fingerprints.length, 1)
    assert.equal(started.known_fingerprints[0].disposition, "unproven")
  }))

/* --------------------------------------------------------- run integrity */

// §10.4: an abandoned run must be recorded as failed, and must not mark its
// topic audited. Otherwise a crash is indistinguishable from a clean audit.
test("start records an abandoned run as failed before opening a new one", () =>
  withProject(({ cwd }) => {
    const abandoned = run(cwd, "start", "--seed", "1")
    // No finish: the agent crashed.
    const restarted = run(cwd, "start", "--seed", "1")

    assert.equal(restarted.recovered_run, abandoned.run_id)
    const runs = ledgerLines(cwd, "topics.jsonl")
    assert.equal(runs.length, 1)
    assert.equal(runs[0].run_id, abandoned.run_id)
    assert.equal(runs[0].outcome, "failed")
  }))

test("an abandoned run leaves its topic unaudited", () =>
  withProject(({ cwd }) => {
    run(cwd, "start", "--seed", "1")
    run(cwd, "start", "--seed", "1")
    run(cwd, "finish")

    const runs = ledgerLines(cwd, "topics.jsonl")
    assert.deepEqual(
      runs.map((entry) => entry.outcome),
      ["failed", "completed"],
    )
  }))

test("finish refuses when no run is open", () =>
  withProject(({ cwd }) => {
    assert.match(runExpectingFailure(cwd, "finish"), /no run is open/)
  }))

test("unreadable run state is reported rather than silently discarded", () =>
  withProject(({ cwd }) => {
    run(cwd, "start", "--seed", "1")
    const gitDir = git(cwd, "rev-parse", "--git-dir")
    writeFileSync(path.join(cwd, gitDir, "continuous-audit-run.json"), "{ not json")
    assert.match(runExpectingFailure(cwd, "status"), /unreadable/)
  }))

test("the run state file is never tracked", () =>
  withProject(({ cwd }) => {
    run(cwd, "start", "--seed", "1")
    assert.equal(git(cwd, "status", "--porcelain"), "")
  }))

test("finish --dry-run reports entries without pushing them", () =>
  withProject(({ cwd }) => {
    run(cwd, "start", "--seed", "1")
    const finished = run(cwd, "finish", "--dry-run")
    assert.equal(finished.pushed, false)
    assert.equal(ledgerLines(cwd, "topics.jsonl").length, 0)
    // The run stays open, so nothing is lost by rehearsing.
    assert.equal(run(cwd, "status").topic_id, "alpha")
  }))

test("AuditFailure is what the module raises for contract violations", () => {
  assert.ok(new AuditFailure("x") instanceof Error)
})
