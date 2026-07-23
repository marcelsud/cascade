import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import {
  CheckFailure,
  checkComplexity,
  checkCoverage,
  checkDuplicates,
  checkTestIntegrity,
  validateIssueRecord,
} from "./checks.mjs"

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()

const writeRelative = (cwd, file, content) => {
  const target = path.join(cwd, file)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, content)
}

const commit = (cwd, message) => {
  git(cwd, "add", ".")
  git(cwd, "commit", "-q", "-m", message)
  return git(cwd, "rev-parse", "HEAD")
}

const makeRepository = () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "cascade-grading-"))
  git(cwd, "init", "-q")
  git(cwd, "config", "user.name", "Cascade Grading Tests")
  git(cwd, "config", "user.email", "grading-tests@example.invalid")
  writeRelative(
    cwd,
    "tests/unit/baseline.test.ts",
    `it.skipIf(process.platform !== "linux")("linux behavior", () => {})\n` +
      `it.runIf(process.platform === "linux")("available behavior", () => {})\n`,
  )
  writeRelative(
    cwd,
    "vitest.config.ts",
    `export default { test: { include: ["tests/**/*.test.ts"] } }\n`,
  )
  writeRelative(cwd, "src/baseline.ts", `export const baseline = (value: number) => value + 1\n`)
  const base = commit(cwd, "baseline")
  return { cwd, base }
}

const withRepository = (callback) => {
  const repository = makeRepository()
  try {
    return callback(repository)
  } finally {
    rmSync(repository.cwd, { recursive: true, force: true })
  }
}

const issueRecord = ({ valueRule, issueGrade, severity }) => ({
  rubric_version: "1.0.1",
  eligibility: Object.fromEntries(
    Array.from({ length: 9 }, (_, index) => [
      `IE-${index + 1}`,
      { answer: "yes", evidence: `Evidence ${index + 1}` },
    ]),
  ),
  severity,
  value_rule: valueRule,
  issue_grade: issueGrade,
  grade_rationale: "This changes a material decision. The selected rule follows from direct evidence.",
})

for (const [valueRule, issueGrade, severity] of [
  ["D-nonconsequential", "D", "cosmetic"],
  ["C-bounded-debt", "C", "material"],
  ["A-blocker", "A", "blocker"],
  ["A-core-guarantee", "A", "material"],
  ["A-multi-component", "A", "material"],
  ["A-project-gate", "A", "material"],
  ["A-release-critical", "A", "material"],
  ["B-localized-material", "B", "material"],
]) {
  test(`issue-grade computes ${valueRule}`, () => {
    assert.equal(validateIssueRecord(issueRecord({ valueRule, issueGrade, severity })).grade, issueGrade)
  })
}

test("issue-grade parses the grading YAML from Markdown", () => {
  const record = issueRecord({ valueRule: "A-blocker", issueGrade: "A", severity: "blocker" })
  const eligibility = Object.entries(record.eligibility)
    .map(([id, entry]) => `  ${id}: { answer: yes, evidence: "${entry.evidence}" }`)
    .join("\n")
  const markdown = `## Slop\n\n\`\`\`yaml\nslop_delta: {}\n\`\`\`\n\n## Grading record\n\n\`\`\`yaml\nrubric_version: 1.0.1\neligibility:\n${eligibility}\nseverity: blocker\nvalue_rule: A-blocker\nissue_grade: A\ngrade_rationale: Direct evidence changes the release decision. Rule A-blocker applies.\n\`\`\`\n`
  assert.equal(validateIssueRecord(markdown).grade, "A")
})

test("issue-grade rejects a mismatched letter", () => {
  assert.throws(
    () =>
      validateIssueRecord(
        issueRecord({ valueRule: "B-localized-material", issueGrade: "A", severity: "material" }),
      ),
    /conflicts/,
  )
})

test("issue-grade rejects missing evidence and rationale", () => {
  const missingEvidence = issueRecord({
    valueRule: "B-localized-material",
    issueGrade: "B",
    severity: "material",
  })
  missingEvidence.eligibility["IE-4"].evidence = ""
  assert.throws(() => validateIssueRecord(missingEvidence), /IE-4/)

  const missingRationale = issueRecord({
    valueRule: "C-bounded-debt",
    issueGrade: "C",
    severity: "material",
  })
  missingRationale.grade_rationale = ""
  assert.throws(() => validateIssueRecord(missingRationale), /grade_rationale/)
})

const coverageReport = (lines) => `
 % Coverage report from v8
-------------------|---------|----------|---------|---------|-------------------
File               | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s
-------------------|---------|----------|---------|---------|-------------------
All files          |   67.57 |    88.95 |   79.41 |   ${lines} |
`

test("RT-4 accepts the versioned floor", () => {
  assert.deepEqual(checkCoverage({ report: coverageReport("67.57"), baseline: 67.57 }), {
    baseline: 67.57,
    current: 67.57,
    delta: 0,
  })
})

test("RT-4 rejects a coverage regression", () => {
  assert.throws(
    () => checkCoverage({ report: coverageReport("67.56"), baseline: 67.57 }),
    /coverage regression/,
  )
})

test("RT-2 preserves the versioned conditional baseline", () => {
  withRepository(({ cwd, base }) => {
    assert.doesNotThrow(() => checkTestIntegrity({ base, cwd }))
  })
})

for (const [mode, source] of [
  ["only", `it.only("focused", () => {})\n`],
  ["skip", `it.skip("disabled", () => {})\n`],
  ["todo", `it.todo("later")\n`],
  ["skipIf", `it.skipIf(true)("disabled", () => {})\n`],
  ["runIf", `it.runIf(false)("disabled", () => {})\n`],
  ["skip.each", `it.skip.each([1])("disabled %s", () => {})\n`],
  ["only.each", `it.only.each([1])("focused %s", () => {})\n`],
  ["fails", `it.fails("expected failure", () => { throw new Error("known") })\n`],
]) {
  test(`RT-2 rejects new ${mode}`, () => {
    withRepository(({ cwd, base }) => {
      writeRelative(cwd, "tests/unit/new.test.ts", source)
      commit(cwd, `add ${mode}`)
      assert.throws(() => checkTestIntegrity({ base, cwd }), CheckFailure)
    })
  })
}

test("RT-2 rejects a test-discovery exclusion", () => {
  withRepository(({ cwd, base }) => {
    writeRelative(
      cwd,
      "vitest.config.ts",
      `export default { test: { include: ["tests/**/*.test.ts"], exclude: ["tests/unit/new.test.ts"] } }\n`,
    )
    commit(cwd, "exclude test")
    assert.throws(() => checkTestIntegrity({ base, cwd }), /test-integrity regression/)
  })
})

const branchingFunction = (name, branches) => {
  const conditions = Array.from(
    { length: branches },
    (_, index) => `  if (value > ${index}) result += ${index + 1}`,
  ).join("\n")
  return `export function ${name}(value: number) {\n  let result = value\n${conditions}\n  return result\n}\n`
}

test("RT-5 reports a new function crossing the ceiling", () => {
  withRepository(({ cwd, base }) => {
    writeRelative(cwd, "src/new-hotspot.ts", branchingFunction("newHotspot", 20))
    commit(cwd, "add hotspot")
    assert.throws(() => checkComplexity({ base, ceiling: 20, cwd }), /complexity signal/)
  })
})

test("RT-5 reports a worsened existing hotspot", () => {
  withRepository(({ cwd }) => {
    writeRelative(cwd, "src/hotspot.ts", branchingFunction("hotspot", 20))
    const hotspotBase = commit(cwd, "add existing hotspot")
    writeRelative(cwd, "src/hotspot.ts", branchingFunction("hotspot", 21))
    commit(cwd, "worsen hotspot")
    assert.throws(
      () => checkComplexity({ base: hotspotBase, ceiling: 20, cwd }),
      /complexity signal/,
    )
  })
})

const duplicatedFunction = (name) => {
  const operations = Array.from({ length: 24 }, (_, index) => `  total += input + ${index}`).join("\n")
  return `export function ${name}(input: number) {\n  let total = input\n${operations}\n  return total\n}\n`
}

test("RT-6 reports a newly duplicated normalized function body", () => {
  withRepository(({ cwd }) => {
    writeRelative(cwd, "src/first.ts", duplicatedFunction("firstRule"))
    const duplicateBase = commit(cwd, "add first rule")
    writeRelative(cwd, "src/second.ts", duplicatedFunction("secondRule"))
    commit(cwd, "duplicate rule")
    assert.throws(
      () => checkDuplicates({ base: duplicateBase, minimumTokens: 60, cwd }),
      /duplicate-rule signal/,
    )
  })
})
