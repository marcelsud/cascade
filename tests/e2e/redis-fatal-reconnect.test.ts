import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { create } from "../../src/core/pipeline.js";
import { createRedisListInput } from "../../src/inputs/redis-list-input.js";
import { createCaptureOutput } from "../../src/testing/capture-output.js";
import { startPipeline, type RunningPipeline } from "./helpers/index.js";

const AUTH_URL = process.env.CASCADE_E2E_REDIS_AUTH_URL;

const parseRedisUrl = (raw: string) => {
  const endpoint = new URL(raw);
  return {
    host: endpoint.hostname || "127.0.0.1",
    port: Number(endpoint.port || "6379"),
  };
};

const withTimeout = async <A>(
  promise: Promise<A>,
  timeoutMs: number,
  label: string,
): Promise<A> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

describe("Redis fatal reconnect with password-protected Redis", () => {
  let tempDir: string | undefined;
  let activeRun: RunningPipeline | undefined;
  let activeChild: ChildProcessWithoutNullStreams | undefined;

  afterEach(async () => {
    if (activeRun) {
      await Effect.runPromise(activeRun.shutdown.requestForce);
      await activeRun.result.catch(() => undefined);
      activeRun = undefined;
    }
    if (activeChild) {
      const child = activeChild;
      activeChild = undefined;
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await new Promise<void>((resolve) => {
          child.once("close", () => resolve());
        });
      }
    }
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("fails the pipeline once credentials are omitted and reconnect is unlimited", async () => {
    if (!AUTH_URL) return;
    const { host, port } = parseRedisUrl(AUTH_URL);
    const startedAt = Date.now();

    // Omit password and maxReconnectAttempts. Default reconnect is unlimited,
    // so a hang would mean fatal errors are still being retried.
    const running = await startPipeline(
      create({
        name: "redis-list-fatal-auth",
        input: createRedisListInput({
          host,
          port,
          key: "cascade-fatal-auth",
          connectTimeout: 1_000,
          commandTimeout: 1_000,
          timeout: 1,
          maxRetriesPerRequest: 1,
          reconnectBackoffMs: 50,
        }),
        processors: [],
        output: await Effect.runPromise(createCaptureOutput()),
      }),
    );
    activeRun = running;

    const result = await withTimeout(
      running.result,
      5_000,
      "passwordless Redis list pipeline",
    );
    activeRun = undefined;
    const elapsed = Date.now() - startedAt;

    expect(result.success).toBe(false);
    expect(
      result.errors?.some(
        (error) =>
          typeof error === "object" &&
          error !== null &&
          "_tag" in error &&
          error._tag === "RedisListInputError",
      ),
    ).toBe(true);
    expect(elapsed).toBeLessThan(5_000);
  }, 10_000);

  it("exits the CLI non-zero for passwordless Redis without reconnect limit", async () => {
    if (!AUTH_URL) return;
    const { host, port } = parseRedisUrl(AUTH_URL);
    tempDir = await mkdtemp(join(tmpdir(), "cascade-redis-fatal-"));
    const configPath = join(tempDir, "redis-fatal.yaml");
    await writeFile(
      configPath,
      `input:
  redis_list:
    url: "redis://${host}:${port}"
    key: cascade-fatal-auth-cli
    connect_timeout: 1000
    command_timeout: 1000
    timeout: 1
    max_retries_per_request: 1
    reconnect_backoff_ms: 50
output:
  capture: {}
`,
      "utf8",
    );

    const startedAt = Date.now();
    const child = spawn(process.execPath, ["src/cli.ts", "run", configPath], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeChild = child;

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    const exitCode = await withTimeout(
      new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code ?? 1));
      }),
      5_000,
      "passwordless Redis CLI run",
    );
    activeChild = undefined;
    const elapsed = Date.now() - startedAt;

    expect(exitCode).not.toBe(0);
    expect(elapsed).toBeLessThan(5_000);
    expect(`${stdout}\n${stderr}`).toMatch(/RedisListInputError|failed|Fatal/i);
  }, 10_000);
});
