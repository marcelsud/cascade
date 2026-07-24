import { afterEach, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  findTestFiles,
  formatTestResults,
  runYamlTests,
} from "../../../src/testing/yaml-test-runner.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const tempDirs: string[] = [];

const createTempDir = async (): Promise<string> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cascade-yaml-runner-"));
  tempDirs.push(dir);
  return dir;
};

const writeFile = async (
  dir: string,
  name: string,
  contents: string,
): Promise<string> => {
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, contents, "utf8");
  return filePath;
};

const VALID_PASSING_TEST = `name: Valid Passing Suite
tests:
  - name: "passes uppercase"
    pipeline:
      input:
        generate:
          count: 1
          template:
            name: "alice"
      processors:
        - uppercase:
            fields: [name]
      output:
        capture: {}
    assertions:
      - type: message_count
        expected: 1
      - type: field_value
        message: 0
        path: content.name
        expected: "ALICE"
`;

const MALFORMED_TEST = `name: Malformed
this is not: [valid yaml
`;

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

const runCliTest = (
  pattern: string,
): Promise<{ code: number | null; output: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", path.join(repoRoot, "src/cli.ts"), "test", pattern],
      {
        cwd: repoRoot,
        env: process.env,
      },
    );

    let output = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      output += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, output });
    });
  });

describe("YAML test runner", () => {
  it("findTestFiles keeps only sorted explicit YAML test files", async () => {
    const dir = await createTempDir();
    const alpha = await writeFile(dir, "alpha.test.yaml", VALID_PASSING_TEST);
    const beta = await writeFile(dir, "beta.test.yml", VALID_PASSING_TEST);
    await writeFile(dir, "pipeline.yaml", "input: {}\noutput: {}\n");
    await writeFile(dir, "not-a-test.yml", "name: nope\n");

    const files = await Effect.runPromise(
      findTestFiles(path.join(dir, "**/*.{yaml,yml}")),
    );

    expect(files).toEqual([alpha, beta].sort((a, b) => a.localeCompare(b)));
    expect(files.every((file) => /\.test\.ya?ml$/i.test(file))).toBe(true);
  });

  it("completes the checked-in suite including build-time expectError and pipeline_failed", async () => {
    const result = await Effect.runPromise(runYamlTests("tests/**/*.yaml"));

    expect(result.failedTests).toBe(0);
    expect(result.totalTests).toBeGreaterThan(0);
    expect(result.files.length).toBeGreaterThan(0);
    expect(
      result.files.every((file) => /\.test\.ya?ml$/i.test(file.fileName)),
    ).toBe(true);

    const allNames = result.files.flatMap((file) =>
      file.tests.map((test) => test.testName),
    );
    expect(allNames).toEqual(
      expect.arrayContaining([
        "Should fail with invalid JSONata expression in mapping",
        "Should validate pipeline_failed assertion",
        "Should fail when assert processor condition is not met",
      ]),
    );

    const formatted = formatTestResults(result);
    expect(formatted).toContain("YAML Test Results");
    expect(formatted).toMatch(/Tests: \d+ passed, 0 failed, \d+ total/);
  });

  it("isolates malformed files and still reports valid neighbors in the summary", async () => {
    const dir = await createTempDir();
    const validPath = await writeFile(
      dir,
      "valid.test.yaml",
      VALID_PASSING_TEST,
    );
    const badPath = await writeFile(dir, "broken.test.yaml", MALFORMED_TEST);

    const result = await Effect.runPromise(
      runYamlTests(path.join(dir, "*.test.yaml")),
    );

    expect(result.files).toHaveLength(2);
    expect(result.totalTests).toBe(2);
    expect(result.passedTests).toBe(1);
    expect(result.failedTests).toBe(1);

    const byName = Object.fromEntries(
      result.files.map((file) => [file.fileName, file]),
    );
    expect(byName[validPath]?.passed).toBe(true);
    expect(byName[badPath]?.passed).toBe(false);
    expect(byName[badPath]?.tests[0]?.passed).toBe(false);

    const formatted = formatTestResults(result);
    expect(formatted).toContain(validPath);
    expect(formatted).toContain(badPath);
    expect(formatted).toContain("Tests: 1 passed, 1 failed, 2 total");
  });

  it("CLI exits non-zero only after printing both files and the aggregate summary", async () => {
    const dir = await createTempDir();
    const validPath = await writeFile(
      dir,
      "valid.test.yaml",
      VALID_PASSING_TEST,
    );
    const badPath = await writeFile(dir, "broken.test.yaml", MALFORMED_TEST);

    const { code, output } = await runCliTest(path.join(dir, "*.test.yaml"));

    expect(code).toBe(1);
    expect(output).toContain("YAML Test Results");
    expect(output).toContain(validPath);
    expect(output).toContain(badPath);
    expect(output).toContain("Tests: 1 passed, 1 failed, 2 total");
  }, 30_000);

  it("returns aggregate success for a temporary all-pass suite", async () => {
    const dir = await createTempDir();
    await writeFile(dir, "ok.test.yaml", VALID_PASSING_TEST);

    const result = await Effect.runPromise(
      runYamlTests(path.join(dir, "*.test.yaml")),
    );

    expect(result.failedTests).toBe(0);
    expect(result.passedTests).toBe(1);
    expect(result.totalTests).toBe(1);
    expect(result.files[0]?.passed).toBe(true);
  });

  it("isolates a bad assertion test without skipping later siblings", async () => {
    const dir = await createTempDir();
    await writeFile(
      dir,
      "assertion-isolation.test.yaml",
      `name: Assertion Isolation
tests:
  - name: "bad assertion dies"
    pipeline:
      input:
        generate:
          count: 1
          template:
            value: 1
      output:
        capture: {}
    assertions:
      - type: all_match
        condition: "{ invalid syntax ["
  - name: "later valid test still runs"
    pipeline:
      input:
        generate:
          count: 1
          template:
            name: "bob"
      processors:
        - uppercase:
            fields: [name]
      output:
        capture: {}
    assertions:
      - type: message_count
        expected: 1
      - type: field_value
        message: 0
        path: content.name
        expected: "BOB"
`,
    );

    const result = await Effect.runPromise(
      runYamlTests(path.join(dir, "*.test.yaml")),
    );

    expect(result.files).toHaveLength(1);
    expect(result.totalTests).toBe(2);
    expect(result.failedTests).toBe(1);
    expect(result.passedTests).toBe(1);

    const tests = result.files[0]?.tests ?? [];
    expect(tests.map((test) => test.testName)).toEqual([
      "bad assertion dies",
      "later valid test still runs",
    ]);
    expect(tests[0]?.passed).toBe(false);
    expect(tests[0]?.error).toMatch(/Assertion error|JSONata/i);
    expect(tests[1]?.passed).toBe(true);
  });

  it("does not let ordinary assertions mask an unexpected pipeline failure", async () => {
    const dir = await createTempDir();
    await writeFile(
      dir,
      "unexpected-failure.test.yaml",
      `name: Unexpected Failure Masking
tests:
  - name: "failed pipeline with message_count zero"
    pipeline:
      input:
        generate:
          count: 1
          template:
            value: 1
      processors:
        - assert:
            condition: content.value > 10
      output:
        capture: {}
    assertions:
      - type: message_count
        expected: 0
`,
    );

    const result = await Effect.runPromise(
      runYamlTests(path.join(dir, "*.test.yaml")),
    );

    expect(result.totalTests).toBe(1);
    expect(result.failedTests).toBe(1);
    expect(result.passedTests).toBe(0);
    expect(result.files[0]?.tests[0]?.passed).toBe(false);
    expect(result.files[0]?.tests[0]?.error).toMatch(/Pipeline failed/i);

    const { code, output } = await runCliTest(path.join(dir, "*.test.yaml"));
    expect(code).toBe(1);
    expect(output).toContain("failed pipeline with message_count zero");
    expect(output).toMatch(/Tests: 0 passed, 1 failed, 1 total/);
  }, 30_000);
});
