import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const runCli = async (
  args: string[],
): Promise<{ code: number | null; output: string }> => {
  const { promise, resolve, reject } = Promise.withResolvers<{
    code: number | null;
    output: string;
  }>();
  const nodeExecutable =
    process.execPath.endsWith("bun") || process.versions.bun
      ? "node"
      : process.execPath;
  const child = spawn(
    nodeExecutable,
    ["--import", "tsx", path.join(repoRoot, "src/cli.ts"), ...args],
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
  return promise;
};

describe("CLI registry loading order", () => {
  it("fails test command when --registry points at a missing module", async () => {
    const { code, output } = await runCli([
      "test",
      "tests/yaml/processors/uppercase.test.yaml",
      "--registry",
      "/definitely/missing-registry.mjs",
    ]);

    expect(code).not.toBe(0);
    expect(output).toContain("Failed to load registry module");
    expect(output).not.toMatch(/All tests passed!/);
  });
});
