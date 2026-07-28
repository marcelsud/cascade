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
  rubric_version: "1.1.0",
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
  const markdown = `## Slop\n\n\`\`\`yaml\nslop_delta: {}\n\`\`\`\n\n## Grading record\n\n\`\`\`yaml\nrubric_version: 1.1.0\neligibility:\n${eligibility}\nseverity: blocker\nvalue_rule: A-blocker\nissue_grade: A\ngrade_rationale: Direct evidence changes the release decision. Rule A-blocker applies.\n\`\`\`\n`
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

for (const [label, file, source, expectFailure, detail] of [
  [
    "ordinary methods named skip",
    "tests/unit/new.test.ts",
    `it("cursor helper", () => {\n  const cursor = { skip: () => 1 }\n  cursor.skip()\n})\n`,
    false,
  ],
  [
    "named Vitest import alias modes",
    "tests/unit/new.test.ts",
    `import { it as spec } from "vitest"\nspec.skip("disabled via alias", () => {})\n`,
    true,
    /new Vitest skip mode/,
  ],
  [
    "namespace-qualified Vitest modes",
    "tests/unit/new.test.ts",
    `import * as vitest from "vitest"\nvitest.it.skip("disabled via namespace", () => {})\n`,
    true,
    /new Vitest skip mode/,
  ],
  [
    "local non-Vitest receivers with Vitest API names",
    "tests/unit/new.test.ts",
    `const it = { skip: (name, fn) => fn() }\nit.skip("not a vitest mode", () => {})\n`,
    false,
  ],
  [
    "nested parameter shadows of Vitest globals",
    "tests/unit/new.test.ts",
    `function run(it) {\n  it.skip("param shadow", () => {})\n}\nrun({ skip: () => {} })\n`,
    false,
  ],
  [
    "non-Vitest default import receivers",
    "tests/unit/new.test.ts",
    `import test from "./helper"\ntest.skip("default import", () => {})\n`,
    false,
  ],
  [
    "destructured local non-Vitest receivers",
    "tests/unit/new.test.ts",
    `const helper = { it: { skip: (name, fn) => fn() } }\nconst { it } = helper\nit.skip("destructured", () => {})\n`,
    false,
  ],
  [
    "closures over later same-spelled locals",
    "tests/unit/new.test.ts",
    `const run = () => test.skip("later local", () => {})\n` +
      `const test = { skip: () => {} }\n` +
      `run()\n`,
    false,
  ],
  [
    "block-contained var hoisted to function scope",
    "tests/unit/new.test.ts",
    `function run() {\n` +
      `  {\n` +
      `    var test = { skip: () => {} }\n` +
      `  }\n` +
      `  test.skip("var hoist", () => {})\n` +
      `}\n` +
      `run()\n`,
    false,
  ],
  [
    "enum declarations shadowing Vitest globals",
    "tests/unit/new.test.ts",
    `enum test {\n  skip = 1,\n}\nvoid test.skip\n`,
    false,
  ],
  [
    "namespace declarations shadowing Vitest globals",
    "tests/unit/new.test.ts",
    `namespace test {\n  export const skip = () => {}\n}\ntest.skip()\n`,
    false,
  ],
  [
    "import-equals declarations shadowing Vitest globals",
    "tests/unit/new.test.ts",
    `import test = require("./helper")\ntest.skip("import equals", () => {})\n`,
    false,
  ],
  [
    "switch-case lexical declarations shadowing Vitest globals",
    "tests/unit/new.test.ts",
    `switch (1) {\n  case 1:\n    const test = { skip: () => {} }\n    test.skip()\n    break\n}\n`,
    false,
  ],
  [
    "mode after Vitest chain modifiers",
    "tests/unit/new.test.ts",
    `it.concurrent.skip("disabled concurrent", () => {})\n`,
    true,
    /new Vitest skip mode/,
  ],
  [
    "global modes inside methods named like Vitest APIs",
    "tests/unit/new.test.ts",
    `const helpers = {\n  it() {\n    it.skip("still a vitest mode", () => {})\n  },\n}\n`,
    true,
    /new Vitest skip mode/,
  ],
  [
    "mode after Vitest chain-returning calls",
    "tests/unit/new.test.ts",
    `it.skipIf(true).skip("disabled after skipIf", () => {})\n`,
    true,
    /new Vitest skip mode/,
  ],
  [
    "changed conditional signatures on provenance-aware receivers",
    "tests/unit/baseline.test.ts",
    `import { it as spec } from "vitest"\n` +
      `spec.skipIf(process.platform !== "darwin")("linux behavior", () => {})\n` +
      `spec.runIf(process.platform === "linux")("available behavior", () => {})\n`,
    true,
    /new or changed conditional mode in blocking unit collection: skipIf\(process\.platform!=="darwin"\)/,
  ],
]) {
  test(`RT-2 ${expectFailure ? "rejects" : "ignores"} ${label}`, () => {
    withRepository(({ cwd, base }) => {
      writeRelative(cwd, file, source)
      commit(cwd, label)
      if (!expectFailure) {
        assert.doesNotThrow(() => checkTestIntegrity({ base, cwd }))
        return
      }
      assert.throws(
        () => checkTestIntegrity({ base, cwd }),
        (error) => {
          assert.ok(error instanceof CheckFailure)
          const text = `${error.message}\n${error.findings.join("\n")}`
          assert.match(text, detail)
          if (file.endsWith("baseline.test.ts")) {
            assert.doesNotMatch(text, /new Vitest skipIf mode/)
            assert.doesNotMatch(text, /new Vitest runIf mode/)
          }
          return true
        },
      )
    })
  })
}

test("RT-2 rejects a test-discovery exclusion", () => {
  withRepository(({ cwd, base }) => {
    writeRelative(
      cwd,
      "vitest.config.ts",
      `export default { test: { include: ["tests/**/*.test.ts"], exclude: ["tests/e2e/**", "tests/unit/extra/**"] } }\n`,
    )
    commit(cwd, "exclude test")
    assert.throws(
      () => checkTestIntegrity({ base, cwd }),
      (error) => {
        assert.ok(error instanceof CheckFailure)
        const detail = `${error.message}\n${error.findings.join("\n")}`
        assert.match(detail, /test-integrity regression|dropped|reduced/)
        assert.match(detail, /tests\/unit\/extra\/sample\.test\.ts/)
        return true
      },
    )
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

const gradingConfig = ({ approved = [], dependencyTransitions = [] } = {}) =>
  [
    "rubric_version: 1.1.0",
    "mode: report-only",
    "ratchets:",
    "  RT-2:",
    "    enforcement: ci-blocking",
    "    approved_test_removals:",
    ...(approved.length === 0
      ? ["      []"]
      : approved.map((entry) => `      - ${JSON.stringify(entry)}`)),
    "    approved_dependency_transitions:",
    ...(dependencyTransitions.length === 0
      ? ["      []"]
      : dependencyTransitions.map((entry) => `      - ${JSON.stringify(entry)}`)),
    "",
  ].join("\n")

test("RT-2 blocking set matches vitest list for tests/unit", () => {
  const expected = listVitestFiles(repoRoot, ["tests/unit"])
  const actual = collectBlockingTestFiles(repoRoot, undefined).files
  assert.ok(actual.length > 0)
  assert.deepEqual(actual, expected)
})

test("RT-2 --exclude collection matches vitest list", () => {
  const exclude = "tests/unit/core/**"
  const script = `vitest run tests/unit --exclude ${exclude}`
  const unfiltered = listVitestFiles(repoRoot, ["tests/unit"])
  const expected = listVitestFiles(repoRoot, ["tests/unit", "--exclude", exclude])
  const actual = collectBlockingTestFiles(repoRoot, undefined, script).files
  assert.ok(expected.length > 0)
  assert.ok(expected.length < unfiltered.length)
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

test("RT-2 rejects shell short-circuit in test:unit", () => {
  withRepository(({ cwd, base }) => {
    writeRelative(
      cwd,
      "package.json",
      `${JSON.stringify(
        {
          name: "cascade-grading-fixture",
          private: true,
          scripts: {
            "test:unit": "vitest run tests/unit/core || vitest run tests/unit",
          },
        },
        null,
        2,
      )}\n`,
    )
    commit(cwd, "shell short-circuit unit script")
    assert.throws(
      () => checkTestIntegrity({ base, cwd }),
      (error) => {
        assert.ok(error instanceof CheckFailure)
        assert.match(error.message, /shell operators|shell/)
        return true
      },
    )
  })
})

test("RT-2 rejects vitest list non-executing subcommand", () => {
  withRepository(({ cwd, base }) => {
    writeRelative(
      cwd,
      "package.json",
      `${JSON.stringify(
        {
          name: "cascade-grading-fixture",
          private: true,
          scripts: {
            "test:unit": "vitest list tests/unit",
          },
        },
        null,
        2,
      )}\n`,
    )
    commit(cwd, "list subcommand unit script")
    assert.throws(
      () => checkTestIntegrity({ base, cwd }),
      (error) => {
        assert.ok(error instanceof CheckFailure)
        assert.match(error.message, /vitest run|subcommand 'list'/)
        return true
      },
    )
  })
})

test("RT-2 fails closed on defineConfig factory config narrowing", () => {
  withRepository(({ cwd, base }) => {
    writeRelative(
      cwd,
      "custom.vitest.config.ts",
      `import { defineConfig } from "vitest/config"\n` +
        `export default defineConfig(() => ({ test: { include: ["tests/unit/core/**"] } }))\n`,
    )
    writeRelative(
      cwd,
      "package.json",
      `${JSON.stringify(
        {
          name: "cascade-grading-fixture",
          private: true,
          scripts: {
            "test:unit": "vitest run tests/unit --config custom.vitest.config.ts",
          },
        },
        null,
        2,
      )}\n`,
    )
    commit(cwd, "factory config")
    assert.throws(
      () => checkTestIntegrity({ base, cwd }),
      (error) => {
        assert.ok(error instanceof CheckFailure)
        const detail = `${error.message}\n${error.findings.join("\n")}`
        assert.match(detail, /blocking unit|dropped|reduced|failed to obtain Vitest collection/)
        return true
      },
    )
  })
})

test("RT-2 fails closed on conditional shorthand include config", () => {
  withRepository(({ cwd, base }) => {
    writeRelative(
      cwd,
      "vitest.config.ts",
      `const include = process.env.CI ? ["tests/unit/core/**"] : ["tests/**/*.test.ts"]\n` +
        `export default { test: { include } }\n`,
    )
    commit(cwd, "conditional shorthand include")
    assert.throws(
      () => checkTestIntegrity({ base, cwd }),
      (error) => {
        assert.ok(error instanceof CheckFailure)
        const detail = `${error.message}\n${error.findings.join("\n")}`
        assert.match(detail, /blocking unit|dropped|reduced/)
        return true
      },
    )
  })
})

test("RT-2 fails closed on re-exported opaque config narrowing", () => {
  withRepository(({ cwd, base }) => {
    writeRelative(
      cwd,
      "vitest.shared.ts",
      `export default { test: { include: ["tests/unit/core/**"] } }\n`,
    )
    writeRelative(
      cwd,
      "vitest.config.ts",
      `import cfg from "./vitest.shared"\nexport default cfg\n`,
    )
    commit(cwd, "re-export config")
    assert.throws(
      () => checkTestIntegrity({ base, cwd }),
      (error) => {
        assert.ok(error instanceof CheckFailure)
        const detail = `${error.message}\n${error.findings.join("\n")}`
        assert.match(detail, /blocking unit|dropped|reduced/)
        return true
      },
    )
  })
})

test("RT-2 inventories skipped tests under build/ and .mjs files", () => {
  withRepository(({ cwd, base }) => {
    writeRelative(cwd, "tests/unit/build/hidden.test.ts", `it.skip("hidden build", () => {})\n`)
    writeRelative(cwd, "tests/unit/hidden.test.mjs", `it.skip("hidden mjs", () => {})\n`)
    writeRelative(
      cwd,
      "vitest.config.ts",
      `export default { test: { include: ["tests/**/*.test.ts", "tests/**/*.test.mjs"], exclude: ["tests/e2e/**"] } }\n`,
    )
    commit(cwd, "add build and mjs skipped tests")
    assert.throws(
      () => checkTestIntegrity({ base, cwd }),
      (error) => {
        assert.ok(error instanceof CheckFailure)
        const detail = `${error.message}\n${error.findings.join("\n")}`
        assert.match(detail, /new Vitest skip mode/)
        return true
      },
    )

    const collection = collectBlockingTestFiles(cwd, undefined)
    assert.ok(collection.files.includes("tests/unit/build/hidden.test.ts"))
    assert.ok(collection.files.includes("tests/unit/hidden.test.mjs"))
  })
})

test("RT-2 accepts in-filter rename with identical content", () => {
  withRepository(({ cwd, base }) => {
    const source = path.join(cwd, "tests/unit/extra/sample.test.ts")
    const target = path.join(cwd, "tests/unit/extra/renamed.test.ts")
    execFileSync("git", ["mv", source, target], { cwd, stdio: "ignore" })
    commit(cwd, "rename within unit filter")
    assert.doesNotThrow(() => checkTestIntegrity({ base, cwd }))
  })
})

test("RT-2 accepts move between unit subdirectories with identical content", () => {
  withRepository(({ cwd, base }) => {
    const source = path.join(cwd, "tests/unit/extra/sample.test.ts")
    const target = path.join(cwd, "tests/unit/core/moved-sample.test.ts")
    mkdirSync(path.dirname(target), { recursive: true })
    execFileSync("git", ["mv", source, target], { cwd, stdio: "ignore" })
    commit(cwd, "move between unit subdirs")
    assert.doesNotThrow(() => checkTestIntegrity({ base, cwd }))
  })
})

test("RT-2 accepts reordering include/exclude keys without pattern change", () => {
  withRepository(({ cwd, base }) => {
    writeRelative(
      cwd,
      "vitest.config.ts",
      `export default { test: { exclude: ["tests/e2e/**"], include: ["tests/**/*.test.ts"] } }\n`,
    )
    commit(cwd, "reorder include exclude keys")
    assert.doesNotThrow(() => checkTestIntegrity({ base, cwd }))
  })
})

test("RT-2 fails closed on head-only workspace narrowing", () => {
  withRepository(({ cwd, base }) => {
    writeRelative(cwd, "vitest.workspace.ts", `export default ["tests/unit/core"]\n`)
    commit(cwd, "head-only workspace subset")
    assert.throws(
      () => checkTestIntegrity({ base, cwd }),
      (error) => {
        assert.ok(error instanceof CheckFailure)
        const detail = `${error.message}\n${error.findings.join("\n")}`
        assert.match(
          detail,
          /blocking unit|dropped|reduced|execution configuration changed|workspace/,
        )
        assert.match(
          detail,
          /tests\/unit\/extra\/sample\.test\.ts|tests\/unit\/baseline\.test\.ts|execution configuration changed/,
        )
        return true
      },
    )
  })
})

test("RT-2 fails closed on config testNamePattern", () => {
  withRepository(({ cwd, base }) => {
    writeRelative(
      cwd,
      "vitest.config.ts",
      `export default { test: { include: ["tests/**/*.test.ts"], exclude: ["tests/e2e/**"], testNamePattern: /core/ } }\n`,
    )
    commit(cwd, "testNamePattern core only")
    assert.throws(
      () => checkTestIntegrity({ base, cwd }),
      (error) => {
        assert.ok(error instanceof CheckFailure)
        const detail = `${error.message}\n${error.findings.join("\n")}`
        assert.match(detail, /execution configuration changed|testNamePattern/)
        return true
      },
    )
  })
})

test("RT-2 fails closed on config dir plus passWithNoTests", () => {
  withRepository(({ cwd, base }) => {
    writeRelative(
      cwd,
      "vitest.config.ts",
      `export default { test: { include: ["tests/**/*.test.ts"], exclude: ["tests/e2e/**"], dir: "tests/unit/core", passWithNoTests: true } }\n`,
    )
    commit(cwd, "dir plus passWithNoTests")
    assert.throws(
      () => checkTestIntegrity({ base, cwd }),
      (error) => {
        assert.ok(error instanceof CheckFailure)
        const detail = `${error.message}\n${error.findings.join("\n")}`
        assert.match(detail, /execution configuration changed|dir=|passWithNoTests|dropped|reduced/)
        return true
      },
    )
  })
})

test("RT-2 fails closed when --mode narrows a config factory collection", () => {
  withRepository(({ cwd, base }) => {
    writeRelative(
      cwd,
      "vitest.config.ts",
      `import { defineConfig } from "vitest/config"\n` +
        `export default defineConfig(({ mode }) => ({\n` +
        `  test: {\n` +
        `    include: mode === "narrow" ? ["tests/unit/core/**"] : ["tests/**/*.test.ts"],\n` +
        `    exclude: ["tests/e2e/**"],\n` +
        `  },\n` +
        `}))\n`,
    )
    writeRelative(
      cwd,
      "package.json",
      `${JSON.stringify(
        {
          name: "cascade-grading-fixture",
          private: true,
          scripts: {
            "test:unit": "vitest run tests/unit --mode narrow",
          },
        },
        null,
        2,
      )}\n`,
    )
    commit(cwd, "mode-narrow factory")
    assert.throws(
      () => checkTestIntegrity({ base, cwd }),
      (error) => {
        assert.ok(error instanceof CheckFailure)
        const detail = `${error.message}\n${error.findings.join("\n")}`
        assert.match(detail, /blocking unit|dropped|reduced|selector reduced/)
        assert.match(
          detail,
          /tests\/unit\/extra\/sample\.test\.ts|tests\/unit\/baseline\.test\.ts/,
        )
        return true
      },
    )
  })
})

test("RT-2 ignores config stdout and trusts only vitest --json collection", () => {
  withRepository(({ cwd, base }) => {
    // Counterfeit every omitted path on stdout. The pre-fix parser treated
    // unrecognized stdout lines as collected files and restored set equality.
    writeRelative(
      cwd,
      "vitest.config.ts",
      `console.log("tests/unit/extra/sample.test.ts")\n` +
        `console.log("tests/unit/baseline.test.ts")\n` +
        `export default { test: { include: ["tests/unit/core/**"] } }\n`,
    )
    commit(cwd, "config logs omitted paths")
    assert.throws(
      () => checkTestIntegrity({ base, cwd }),
      (error) => {
        assert.ok(error instanceof CheckFailure)
        const detail = `${error.message}\n${error.findings.join("\n")}`
        assert.match(detail, /blocking unit|dropped|reduced/)
        assert.match(detail, /tests\/unit\/extra\/sample\.test\.ts|tests\/unit\/baseline\.test\.ts/)
        return true
      },
    )
  })
})
test("RT-2 fails closed when lockfile/dependencies differ between base and head", () => {
  withRepository(({ cwd, base }) => {
    // No test-file drop: only dependency manifests change. The pre-fix checker
    // reused head's install for the base worktree and would still report equal
    // collections. Fail closed on the drift itself instead.
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
          devDependencies: {
            vitest: "2.1.9",
          },
        },
        null,
        2,
      )}\n`,
    )
    writeRelative(
      cwd,
      "bun.lock",
      `{\n  "lockfileVersion": 1,\n  "workspaces": {\n    "": {\n      "name": "cascade-grading-fixture",\n      "devDependencies": {\n        "vitest": "2.1.8"\n      }\n    }\n  }\n}\n`,
    )
    commit(cwd, "dependency drift only")
    assert.throws(
      () => checkTestIntegrity({ base, cwd }),
      (error) => {
        assert.ok(error instanceof CheckFailure)
        assert.match(
          error.message,
          /unapproved dependency change/,
        )
        assert.match(error.message, /approved_dependency_transitions/)
        return true
      },
    )
  })
})

// Writes the dependency change the three approval tests share and returns the
// exact transition fingerprint RT-2 asks the maintainer to authorize.
const applyDependencyDrift = (cwd) => {
  writeRelative(
    cwd,
    "package.json",
    `${JSON.stringify(
      {
        name: "cascade-grading-fixture",
        private: true,
        scripts: { "test:unit": "vitest run tests/unit" },
        devDependencies: { vitest: "2.1.9" },
      },
      null,
      2,
    )}\n`,
  )
}

const transitionFromFailure = (cwd, base) => {
  try {
    checkTestIntegrity({ base, cwd })
  } catch (error) {
    const match = /"([0-9a-f]{64}:[0-9a-f]{64})"/.exec(error.message)
    assert.ok(match, `expected a transition fingerprint in: ${error.message}`)
    return match[1]
  }
  assert.fail("expected the unapproved dependency transition to fail closed")
}

test("RT-2 accepts a dependency transition approved at the merge base", () => {
  withRepository(({ cwd, base }) => {
    // Discover the exact entry the diagnostic tells a maintainer to land.
    applyDependencyDrift(cwd)
    commit(cwd, "probe dependency drift")
    const transition = transitionFromFailure(cwd, base)

    // Land it as a policy-only PR on top of the original base, exactly as the
    // diagnostic instructs: revert the dependency change, approve, commit.
    execFileSync("git", ["revert", "--no-edit", "HEAD"], { cwd, stdio: "ignore" })
    writeRelative(
      cwd,
      ".github/grading/config.yml",
      gradingConfig({ dependencyTransitions: [transition] }),
    )
    const policyBase = commit(cwd, "approve dependency transition")

    // Now rebase the dependency change onto the approved policy.
    applyDependencyDrift(cwd)
    commit(cwd, "land approved dependency change")

    assert.doesNotThrow(() => checkTestIntegrity({ base: policyBase, cwd }))
  })
})

test("RT-2 rejects a head-only approved dependency transition", () => {
  withRepository(({ cwd, base }) => {
    applyDependencyDrift(cwd)
    commit(cwd, "probe dependency drift")
    const transition = transitionFromFailure(cwd, base)
    execFileSync("git", ["revert", "--no-edit", "HEAD"], { cwd, stdio: "ignore" })
    // Base carries the approvals list but not this entry.
    writeRelative(cwd, ".github/grading/config.yml", gradingConfig({}))
    const policyBase = commit(cwd, "no approval at base")

    // Self-approval: the same PR both changes dependencies and authorizes it.
    applyDependencyDrift(cwd)
    writeRelative(
      cwd,
      ".github/grading/config.yml",
      gradingConfig({ dependencyTransitions: [transition] }),
    )
    commit(cwd, "dependency change self-approved in head")

    assert.throws(
      () => checkTestIntegrity({ base: policyBase, cwd }),
      (error) => {
        assert.ok(error instanceof CheckFailure)
        assert.match(error.message, /unapproved dependency change/)
        return true
      },
    )
  })
})

test("RT-2 rejects a dependency transition approved for different fingerprints", () => {
  withRepository(({ cwd, base }) => {
    // An approval must authorize one exact base->head pair, not any change.
    const unrelated = `${"a".repeat(64)}:${"b".repeat(64)}`
    writeRelative(
      cwd,
      ".github/grading/config.yml",
      gradingConfig({ dependencyTransitions: [unrelated] }),
    )
    const policyBase = commit(cwd, "approve an unrelated transition")
    assert.notEqual(policyBase, base)

    applyDependencyDrift(cwd)
    commit(cwd, "unrelated dependency change")

    assert.throws(
      () => checkTestIntegrity({ base: policyBase, cwd }),
      (error) => {
        assert.ok(error instanceof CheckFailure)
        assert.match(error.message, /unapproved dependency change/)
        return true
      },
    )
  })
})

test("RT-2 fails closed on nested workspace project testNamePattern", () => {
  withRepository(({ cwd, base }) => {
    writeRelative(cwd, "vitest.workspace.ts", `export default ["packages/*"]\n`)
    writeRelative(
      cwd,
      "packages/a/vitest.config.ts",
      `export default {\n` +
        `  test: {\n` +
        `    name: "a",\n` +
        `    include: ["../../tests/**/*.test.ts"],\n` +
        `  },\n` +
        `}\n`,
    )
    // Establish the workspace at the merge-base so the nested project config
    // change is the only execution-key delta under test.
    const workspaceBase = commit(cwd, "workspace baseline")

    writeRelative(
      cwd,
      "packages/a/vitest.config.ts",
      `export default {\n` +
        `  test: {\n` +
        `    name: "a",\n` +
        `    include: ["../../tests/**/*.test.ts"],\n` +
        `    testNamePattern: /core/,\n` +
        `  },\n` +
        `}\n`,
    )
    commit(cwd, "nested project testNamePattern")
    assert.throws(
      () => checkTestIntegrity({ base: workspaceBase, cwd }),
      (error) => {
        assert.ok(error instanceof CheckFailure)
        const detail = `${error.message}\n${error.findings.join("\n")}`
        assert.match(detail, /execution configuration changed|testNamePattern/)
        return true
      },
    )
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

test("RT-6 ignores non-source files under src", () => {
  withRepository(({ cwd }) => {
    writeRelative(cwd, "src/first.ts", duplicatedFunction("firstRule"))
    writeRelative(cwd, "src/AGENTS.md", "# notes\n")
    const base = commit(cwd, "add first rule and notes")
    writeRelative(cwd, "src/second.ts", "export const unrelated = () => 1\n")
    commit(cwd, "add unrelated rule")
    assert.deepEqual(checkDuplicates({ base, minimumTokens: 60, cwd }), { findings: [] })
  })
})
