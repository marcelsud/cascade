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
  collectBlockingTestFiles,
  validateIssueRecord,
} from "./checks.mjs"
import { fileURLToPath } from "node:url"

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
    "package.json",
    `${JSON.stringify(
      {
        name: "cascade-grading-fixture",
        private: true,
        scripts: {
          "test:unit": "vitest run tests/unit",
        },
      },
      null,
      2,
    )}\n`,
  )
  writeRelative(
    cwd,
    "tests/unit/baseline.test.ts",
    `it.skipIf(process.platform !== "linux")("linux behavior", () => {})\n` +
      `it.runIf(process.platform === "linux")("available behavior", () => {})\n`,
  )
  writeRelative(
    cwd,
    "tests/unit/core/sample.test.ts",
    `it("core sample", () => {})\n`,
  )
  writeRelative(
    cwd,
    "tests/unit/extra/sample.test.ts",
    `it("extra sample", () => {})\n`,
  )
  writeRelative(
    cwd,
    "vitest.config.ts",
    `export default { test: { include: ["tests/**/*.test.ts"], exclude: ["tests/e2e/**"] } }\n`,
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
All files          |   67.05 |    88.95 |   79.41 |   ${lines} |
`

test("RT-4 accepts the versioned floor", () => {
  assert.deepEqual(checkCoverage({ report: coverageReport("67.05"), baseline: 67.05 }), {
    baseline: 67.05,
    current: 67.05,
    delta: 0,
  })
})

test("RT-4 rejects a coverage regression", () => {
  assert.throws(
    () => checkCoverage({ report: coverageReport("67.04"), baseline: 67.05 }),
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

test("RT-2 rejects narrowing the blocking runner filter", () => {
  withRepository(({ cwd, base }) => {
    writeRelative(
      cwd,
      "package.json",
      `${JSON.stringify(
        {
          name: "cascade-grading-fixture",
          private: true,
          scripts: {
            "test:unit": "vitest run tests/unit/core",
          },
        },
        null,
        2,
      )}\n`,
    )
    commit(cwd, "narrow unit filter")
    assert.throws(
      () => checkTestIntegrity({ base, cwd }),
      (error) => {
        assert.ok(error instanceof CheckFailure)
        const detail = `${error.message}\n${error.findings.join("\n")}`
        assert.match(detail, /blocking unit/)
        assert.match(detail, /tests\/unit\/extra\/sample\.test\.ts|tests\/unit\/baseline\.test\.ts|selector reduced|dropped/)
        return true
      },
    )
  })
})

test("RT-2 rejects moving a selected test outside the runner filter", () => {
  withRepository(({ cwd, base }) => {
    const source = path.join(cwd, "tests/unit/extra/sample.test.ts")
    const target = path.join(cwd, "tests/other/moved.test.ts")
    mkdirSync(path.dirname(target), { recursive: true })
    execFileSync("git", ["mv", source, target], { cwd, stdio: "ignore" })
    commit(cwd, "move test outside unit filter")
    assert.throws(
      () => checkTestIntegrity({ base, cwd }),
      (error) => {
        assert.ok(error instanceof CheckFailure)
        const detail = `${error.message}\n${error.findings.join("\n")}`
        assert.match(detail, /tests\/unit\/extra\/sample\.test\.ts/)
        return true
      },
    )
  })
})

test("RT-2 mode inventory ignores excluded non-blocking tests", () => {
  withRepository(({ cwd, base }) => {
    writeRelative(cwd, "tests/e2e/ignored.test.ts", `it.only("not blocking", () => {})\n`)
    writeRelative(cwd, "tests/helpers/not-collected.ts", `it.only("helper only", () => {})\n`)
    commit(cwd, "add excluded e2e and non-test helper")
    assert.doesNotThrow(() => checkTestIntegrity({ base, cwd }))
  })
})

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

const listVitestFiles = (cwd, args) =>
  execFileSync("npx", ["vitest", "list", ...args, "--filesOnly"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(path.sep).join("/"))
    .sort()

const gradingConfig = ({ approved = [] } = {}) =>
  [
    "rubric_version: 1.0.1",
    "mode: report-only",
    "ratchets:",
    "  RT-2:",
    "    enforcement: ci-blocking",
    "    approved_test_removals:",
    ...(approved.length === 0
      ? ["      []"]
      : approved.map((entry) => `      - ${JSON.stringify(entry)}`)),
    "",
  ].join("\n")

test("RT-2 blocking set matches vitest list for tests/unit", () => {
  const expected = listVitestFiles(repoRoot, ["tests/unit"])
  const actual = collectBlockingTestFiles(repoRoot, undefined).files
  assert.equal(actual.length, 55)
  assert.deepEqual(actual, expected)
})

test("RT-2 --exclude collection matches vitest list", () => {
  const exclude = "tests/unit/core/**"
  const script = `vitest run tests/unit --exclude ${exclude}`
  const expected = listVitestFiles(repoRoot, ["tests/unit", "--exclude", exclude])
  const actual = collectBlockingTestFiles(repoRoot, undefined, script).files
  assert.ok(expected.length > 0)
  assert.ok(expected.length < 55)
  assert.deepEqual(actual, expected)
})

test("RT-2 rejects --exclude narrowing of the blocking set", () => {
  withRepository(({ cwd, base }) => {
    writeRelative(
      cwd,
      "package.json",
      `${JSON.stringify(
        {
          name: "cascade-grading-fixture",
          private: true,
          scripts: {
            "test:unit": "vitest run tests/unit --exclude tests/unit/extra/**",
          },
        },
        null,
        2,
      )}\n`,
    )
    commit(cwd, "exclude extra via CLI")
    assert.throws(
      () => checkTestIntegrity({ base, cwd }),
      (error) => {
        assert.ok(error instanceof CheckFailure)
        const detail = `${error.message}\n${error.findings.join("\n")}`
        assert.match(detail, /tests\/unit\/extra\/sample\.test\.ts/)
        return true
      },
    )
  })
})

test("RT-2 fails closed on unsupported Vitest selectors", () => {
  withRepository(({ cwd, base }) => {
    for (const script of [
      "vitest run tests/unit -t focused",
      "vitest run tests/unit --testNamePattern focused",
      "vitest run tests/unit --project unit",
      "vitest run tests/unit --changed",
      "vitest run tests/unit --shard 1/2",
      "vitest run tests/unit --workspace vitest.workspace.ts",
    ]) {
      writeRelative(
        cwd,
        "package.json",
        `${JSON.stringify(
          {
            name: "cascade-grading-fixture",
            private: true,
            scripts: { "test:unit": script },
          },
          null,
          2,
        )}\n`,
      )
      commit(cwd, `unsupported ${script}`)
      assert.throws(
        () => checkTestIntegrity({ base, cwd }),
        (error) => {
          assert.ok(error instanceof CheckFailure)
          assert.match(error.message, /unsupported Vitest selector|cannot model/)
          return true
        },
      )
    }
  })
})

test("RT-2 rejects head-only approved_test_removals", () => {
  withRepository(({ cwd, base }) => {
    writeRelative(cwd, ".github/grading/config.yml", gradingConfig({ approved: [] }))
    // Establish base without the extra file approved.
    const policyBase = commit(cwd, "empty approval policy")

    writeRelative(cwd, ".github/grading/config.yml", gradingConfig({
      approved: ["tests/unit/extra/sample.test.ts"],
    }))
    writeRelative(cwd, "tests/unit/extra/sample.test.ts", "") // delete via empty then remove
    execFileSync("git", ["rm", "-f", "tests/unit/extra/sample.test.ts"], {
      cwd,
      stdio: "ignore",
    })
    commit(cwd, "drop extra and self-approve in head")

    assert.throws(
      () => checkTestIntegrity({ base: policyBase, cwd }),
      (error) => {
        assert.ok(error instanceof CheckFailure)
        const detail = `${error.message}\n${error.findings.join("\n")}`
        assert.match(detail, /tests\/unit\/extra\/sample\.test\.ts/)
        return true
      },
    )
  })
})

test("RT-2 accepts removals approved at merge-base", () => {
  withRepository(({ cwd }) => {
    writeRelative(cwd, ".github/grading/config.yml", gradingConfig({
      approved: ["tests/unit/extra/sample.test.ts"],
    }))
    const policyBase = commit(cwd, "pre-approve extra removal")

    execFileSync("git", ["rm", "-f", "tests/unit/extra/sample.test.ts"], {
      cwd,
      stdio: "ignore",
    })
    commit(cwd, "drop pre-approved extra")

    assert.doesNotThrow(() => checkTestIntegrity({ base: policyBase, cwd }))
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
