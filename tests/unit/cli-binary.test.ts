import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
let scratch: string;
let binary: string;

describe("standalone CLI distribution", () => {
  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "cascade-binary-"));
    binary = join(
      scratch,
      process.platform === "win32" ? "cascade.exe" : "cascade",
    );
    await execute(
      "bun",
      ["build", "src/cli.ts", "--compile", "--outfile", binary],
      {
        cwd: root,
        timeout: 45_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
  }, 60_000);

  afterAll(async () => {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  it("reports the package version without a Node or Bun installation in PATH", async () => {
    const { version } = JSON.parse(
      await readFile(join(root, "package.json"), "utf8"),
    );
    const result = await execute(binary, ["--version"], {
      cwd: scratch,
      env: { ...process.env, PATH: "" },
      timeout: 5_000,
    });
    expect(result.stdout.trim()).toBe(`cascade v${version}`);
  });

  it("runs JavaScript from a standalone executable without external WASM files", async () => {
    const config = join(scratch, "javascript.yaml");
    await writeFile(
      config,
      `input:
  stdin:
    mode: lines
pipeline:
  processors:
    - javascript:
        code: |
          return { name: content.name.toUpperCase(), count: content.count + 1 };
output:
  stdout:
    format: content
`,
    );
    const processResult = await new Promise<{
      code: number | null;
      stdout: string;
      stderr: string;
    }>((resolveResult, reject) => {
      const child = execFile(
        binary,
        ["run", config],
        {
          cwd: scratch,
          env: { ...process.env, PATH: "" },
          timeout: 5_000,
        },
        (error, stdout, stderr) => {
          if (error && !("code" in error)) {
            reject(error);
            return;
          }
          resolveResult({ code: child.exitCode, stdout, stderr });
        },
      );
      child.stdin?.end('{"name":"cascade","count":6}\n');
    });
    expect(
      processResult.code,
      processResult.stdout + processResult.stderr,
    ).toBe(0);
    const lines = processResult.stdout.split(/\r?\n/);
    expect(lines).toContain('{"name":"CASCADE","count":7}');
    expect(processResult.stderr).not.toContain("emscripten-module.wasm");
  });
});
