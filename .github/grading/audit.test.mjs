import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import {
  AuditFailure,
  churnSince,
  completedRuns,
  computeWeights,
  fingerprint,
  loadTopics,
  readLedger,
  seededRandom,
  selectTopic,
  selectableTopics,
  validateFindingEntry,
  validateRunEntry,
} from "./audit.mjs"

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()

const writeRelative = (cwd, file, content) => {
  const target = path.join(cwd, file)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, content)
}

const withTempDir = (callback) => {
  const cwd = mkdtempSync(path.join(tmpdir(), "cascade-audit-"))
  try {
    return callback(cwd)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

const withRepository = (callback) =>
  withTempDir((cwd) => {
    git(cwd, "init", "-q")
    git(cwd, "config", "user.name", "Cascade Audit Tests")
    git(cwd, "config", "user.email", "audit-tests@example.invalid")
    writeRelative(cwd, "src/alpha.ts", "export const alpha = 1\n")
    writeRelative(cwd, "src/beta.ts", "export const beta = 1\n")
    git(cwd, "add", ".")
    git(cwd, "commit", "-q", "-m", "baseline")
    return callback({ cwd, base: git(cwd, "rev-parse", "HEAD") })
  })

const configFor = (topics, objectives = { "REL-1": "delivery", "REL-2": "contracts" }) =>
  `rubric_version: 1.1.0\nobjectives:\n${Object.entries(objectives)
    .map(([id, text]) => `  ${id}: ${text}`)
    .join("\n")}\ntopics:\n${topics
    .map(
      (topic) =>
        `  - id: ${topic.id}\n    paths: [${topic.paths.join(", ")}]\n    objectives: [${topic.objectives.join(", ")}]`,
    )
    .join("\n")}\n`

const topicsOf = (ids) =>
  ids.map((id) => ({ id, paths: [`src/${id}.ts`], objectives: ["REL-1"] }))

const runEntry = (topicId, { outcome = "completed", commit = "abc123" } = {}) => ({
  topic_id: topicId,
  run_id: `run-${topicId}`,
  commit_audited: commit,
  seed: 1,
  outcome,
})

/* ------------------------------------------------------------------ config */

test("loadTopics rejects a config with no topics", () =>
  withTempDir((cwd) => {
    const file = path.join(cwd, "config.yml")
    writeFileSync(file, "rubric_version: 1.1.0\nobjectives:\n  REL-1: delivery\n")
    assert.throws(() => loadTopics(file), AuditFailure)
  }))

test("loadTopics rejects duplicate topic ids", () =>
  withTempDir((cwd) => {
    const file = path.join(cwd, "config.yml")
    writeFileSync(file, configFor(topicsOf(["alpha", "alpha"])))
    assert.throws(() => loadTopics(file), /duplicate topic id/)
  }))

test("loadTopics rejects a topic without paths or objectives", () =>
  withTempDir((cwd) => {
    const file = path.join(cwd, "config.yml")
    writeFileSync(file, "rubric_version: 1.1.0\nobjectives:\n  REL-1: d\ntopics:\n  - id: alpha\n")
    assert.throws(() => loadTopics(file), /declares no paths/)
  }))

// Spec §5: a topic citing an unregistered objective would fail IE-7 only after
// the reproduction was already paid for, so it must never be selected.
test("selectableTopics drops topics citing an unregistered objective", () => {
  const topics = [
    { id: "alpha", paths: ["src/a.ts"], objectives: ["REL-1"] },
    { id: "beta", paths: ["src/b.ts"], objectives: ["REL-1", "GHOST-9"] },
  ]
  const eligible = selectableTopics({ topics, objectives: new Set(["REL-1", "REL-2"]) })
  assert.deepEqual(
    eligible.map((topic) => topic.id),
    ["alpha"],
  )
})

/* -------------------------------------------------------------- selection */

test("seededRandom is deterministic and stays in range", () => {
  const first = Array.from({ length: 20 }, seededRandom(7))
  const second = Array.from({ length: 20 }, seededRandom(7))
  assert.deepEqual(first, second)
  assert.notDeepEqual(first, Array.from({ length: 20 }, seededRandom(8)))
  for (const value of first) {
    assert.ok(value >= 0 && value < 1)
  }
})

// Spec §6.2: same ledger, same commit, same seed produce the same topic.
test("selectTopic is reproducible for a given seed", () => {
  const topics = topicsOf(["alpha", "beta", "gamma", "delta"])
  const runs = topics.map((topic) => runEntry(topic.id))
  const pick = () => selectTopic({ topics, runs, seed: 4242 }).selected.id
  assert.equal(pick(), pick())
})

// Spec §6.3: newly registered topics are audited before previously covered ones.
test("selectTopic exhausts unaudited topics before revisiting audited ones", () => {
  const topics = topicsOf(["alpha", "beta", "fresh"])
  // 'alpha' and 'beta' carry heavy churn, which would outweigh a new topic if
  // weighting alone decided the pool.
  const runs = [runEntry("alpha"), runEntry("beta")]
  for (let seed = 0; seed < 50; seed += 1) {
    const { selected } = selectTopic({ topics, runs, seed, churnOf: () => 999 })
    assert.equal(selected.id, "fresh", `seed ${seed} escaped the unaudited pool`)
  }
})

// Spec §9.2: a failed run must not mark its topic audited.
test("a failed run leaves its topic unaudited", () => {
  const topics = topicsOf(["alpha", "beta"])
  const runs = [runEntry("alpha", { outcome: "failed" }), runEntry("beta")]
  const { rows } = computeWeights({ topics, runs, churnOf: () => 0 })
  assert.equal(rows.find((row) => row.id === "alpha").audited, false)
  assert.equal(rows.find((row) => row.id === "beta").audited, true)

  for (let seed = 0; seed < 20; seed += 1) {
    assert.equal(selectTopic({ topics, runs, seed }).selected.id, "alpha")
  }
})

// Spec §6.1: weight = staleness x (1 + churn).
test("computeWeights applies staleness x (1 + churn)", () => {
  const topics = topicsOf(["alpha", "beta"])
  const runs = [runEntry("alpha"), runEntry("beta")]
  const { rows } = computeWeights({ topics, runs, churnOf: (topic) => (topic.id === "alpha" ? 4 : 0) })
  const alpha = rows.find((row) => row.id === "alpha")
  const beta = rows.find((row) => row.id === "beta")

  assert.equal(alpha.staleness, 2)
  assert.equal(alpha.weight, 2 * (1 + 4))
  assert.equal(beta.staleness, 1)
  assert.equal(beta.weight, 1 * (1 + 0))
})

// Spec §6.1: uniform selection is forbidden; churn must shift the distribution.
test("churn shifts the distribution toward recently changed topics", () => {
  const topics = topicsOf(["quiet", "busy"])
  const runs = [runEntry("quiet"), runEntry("busy")]
  let busy = 0
  for (let seed = 0; seed < 400; seed += 1) {
    const { selected } = selectTopic({
      topics,
      runs,
      seed,
      churnOf: (topic) => (topic.id === "busy" ? 40 : 0),
    })
    if (selected.id === "busy") busy += 1
  }
  // 'busy' has staleness 1 x churn 41 = 41 against 'quiet' staleness 2 x 1 = 2.
  assert.ok(busy > 300, `expected the churned topic to dominate, got ${busy}/400`)
})

test("selectTopic refuses an empty topic set", () => {
  assert.throws(() => selectTopic({ topics: [], runs: [], seed: 1 }), /no selectable topics/)
})

/* ------------------------------------------------------------------ churn */

test("churnSince counts only commits touching the topic paths", () =>
  withRepository(({ cwd, base }) => {
    writeRelative(cwd, "src/alpha.ts", "export const alpha = 2\n")
    git(cwd, "add", ".")
    git(cwd, "commit", "-q", "-m", "touch alpha")
    writeRelative(cwd, "src/beta.ts", "export const beta = 2\n")
    git(cwd, "add", ".")
    git(cwd, "commit", "-q", "-m", "touch beta")

    assert.equal(churnSince({ paths: ["src/alpha.ts"], sinceCommit: base, cwd }), 1)
    assert.equal(churnSince({ paths: ["src/beta.ts"], sinceCommit: base, cwd }), 1)
    assert.equal(churnSince({ paths: ["src/"], sinceCommit: base, cwd }), 2)
  }))

test("churnSince yields no signal for an absent or unreachable commit", () =>
  withRepository(({ cwd }) => {
    assert.equal(churnSince({ paths: ["src/"], sinceCommit: undefined, cwd }), 0)
    assert.equal(churnSince({ paths: ["src/"], sinceCommit: "0".repeat(40), cwd }), 0)
  }))

/* ----------------------------------------------------------------- ledger */

test("readLedger is empty when the ledger branch does not exist", () =>
  withRepository(({ cwd }) => {
    assert.deepEqual(readLedger({ cwd }), { runs: [], findings: [] })
  }))

test("readLedger parses entries from the ledger branch", () =>
  withRepository(({ cwd }) => {
    git(cwd, "checkout", "-q", "--orphan", "grading-ledger")
    git(cwd, "rm", "-rq", "--cached", ".")
    rmSync(path.join(cwd, "src"), { recursive: true, force: true })
    writeRelative(cwd, "topics.jsonl", `${JSON.stringify(runEntry("alpha"))}\n`)
    writeRelative(
      cwd,
      "findings.jsonl",
      `${JSON.stringify({ fingerprint: "f1", topic_id: "alpha", disposition: "filed" })}\n`,
    )
    git(cwd, "add", ".")
    git(cwd, "commit", "-q", "-m", "ledger")
    git(cwd, "checkout", "-q", "main")

    const ledger = readLedger({ cwd })
    assert.equal(ledger.runs.length, 1)
    assert.equal(ledger.runs[0].topic_id, "alpha")
    assert.equal(ledger.findings[0].fingerprint, "f1")
  }))

test("completedRuns excludes failed runs", () => {
  const runs = [runEntry("a"), runEntry("b", { outcome: "failed" }), runEntry("c")]
  assert.deepEqual(
    completedRuns(runs).map((run) => run.topic_id),
    ["a", "c"],
  )
})

test("validateRunEntry requires the recorded fields and a known outcome", () => {
  assert.throws(() => validateRunEntry({ topic_id: "alpha" }), /requires run_id/)
  assert.throws(() => validateRunEntry(runEntry("a", { outcome: "partial" })), /outcome must be/)
  assert.doesNotThrow(() => validateRunEntry(runEntry("a")))
})

const finding = (overrides = {}) => ({
  fingerprint: "f1",
  topic_id: "alpha",
  run_id: "run-1",
  commit_audited: "abc123",
  path: "src/alpha.ts",
  consequence_category: "reliability",
  normalized_claim: "unbounded buffer",
  disposition: "filed",
  ...overrides,
})

// Spec §9.3: §8.3 keys re-eligibility on why a candidate was rejected, so a
// rejection without a reason cannot be re-audited correctly.
test("validateFindingEntry requires a reason for every rejection", () => {
  assert.doesNotThrow(() => validateFindingEntry(finding()))
  for (const disposition of ["duplicate", "not-current", "unproven", "ineligible"]) {
    assert.throws(() => validateFindingEntry(finding({ disposition })), /requires a reason/)
    assert.doesNotThrow(() => validateFindingEntry(finding({ disposition, reason: "checked" })))
  }
})

test("validateFindingEntry rejects an unknown disposition", () => {
  assert.throws(() => validateFindingEntry(finding({ disposition: "maybe" })), /disposition must be/)
})

/* ------------------------------------------------------------ fingerprint */

// Spec §8.1: line numbers are excluded because they drift with unrelated edits.
test("fingerprint ignores case, whitespace, and is stable across line moves", async () => {
  const base = await fingerprint({
    path: "src/inputs/http-input.ts",
    consequenceCategory: "reliability",
    normalizedClaim: "request bodies buffered without a byte limit",
  })
  const noisy = await fingerprint({
    path: "SRC/Inputs/HTTP-Input.ts",
    consequenceCategory: "reliability",
    normalizedClaim: "  Request bodies   buffered without a byte limit  ",
  })
  assert.equal(base, noisy)

  const different = await fingerprint({
    path: "src/inputs/http-input.ts",
    consequenceCategory: "reliability",
    normalizedClaim: "request bodies read without a deadline",
  })
  assert.notEqual(base, different)
})

test("fingerprint separates identical claims in different files", async () => {
  const shared = { consequenceCategory: "reliability", normalizedClaim: "same claim" }
  assert.notEqual(
    await fingerprint({ path: "src/a.ts", ...shared }),
    await fingerprint({ path: "src/b.ts", ...shared }),
  )
})

/* -------------------------------------------------------- real repository */

test("the project config yields selectable topics whose paths all exist", () => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const repoRoot = path.resolve(here, "../..")
  const { topics, objectives } = loadTopics(path.join(here, "config.yml"))
  const eligible = selectableTopics({ topics, objectives })

  assert.equal(eligible.length, topics.length, "every declared topic must cite a known objective")
  for (const topic of topics) {
    for (const declared of topic.paths) {
      assert.ok(
        existsSync(path.join(repoRoot, declared)),
        `topic ${topic.id} declares a missing path: ${declared}`,
      )
    }
  }
})
