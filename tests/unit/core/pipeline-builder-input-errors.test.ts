import { afterEach, describe, expect, it } from "vitest";
import { Cause, Effect, Exit, Option } from "effect";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BuildError,
  buildPipeline,
} from "../../../src/core/pipeline-builder.js";
import type { PipelineConfig } from "../../../src/core/config-loader.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const tempDirs: string[] = [];

const createTempDir = async (): Promise<string> => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "cascade-input-build-errors-"),
  );
  tempDirs.push(dir);
  return dir;
};

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

const expectBuildFailure = async (
  config: PipelineConfig,
  messageSubstring: string,
) => {
  const exit = await Effect.runPromiseExit(buildPipeline(config));

  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    expect(Option.isSome(Cause.failureOption(exit.cause))).toBe(true);
    expect(Option.isNone(Cause.dieOption(exit.cause))).toBe(true);

    const failure = Option.getOrThrow(Cause.failureOption(exit.cause));
    expect(failure).toBeInstanceOf(BuildError);
    expect(failure.message).toContain(messageSubstring);
  }
};

const runCliValidate = async (
  fixturePath: string,
): Promise<{ code: number | null; output: string }> => {
  let resolve!: (value: { code: number | null; output: string }) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<{
    code: number | null;
    output: string;
  }>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // bun test sets process.execPath to bun; CLI spawn needs real Node + tsx.
  const nodeExecutable =
    process.execPath.endsWith("bun") || process.versions.bun
      ? "node"
      : process.execPath;
  const child = spawn(
    nodeExecutable,
    [
      "--import",
      "tsx",
      path.join(repoRoot, "src/cli.ts"),
      "validate",
      fixturePath,
    ],
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

describe("pipeline-builder input construction errors", () => {
  it("converts redis_pubsub missing channels/patterns into BuildError Fail", async () => {
    await expectBuildFailure(
      {
        input: {
          redis_pubsub: {
            url: "redis://localhost:6379",
          },
        },
        output: {
          capture: {},
        },
      } as PipelineConfig,
      "Redis Pub/Sub Input requires at least one channel or pattern",
    );
  });

  it("converts file input missing path into BuildError Fail", async () => {
    const missingPath = path.join(
      os.tmpdir(),
      `cascade-missing-input-${Date.now()}.log`,
    );

    await expectBuildFailure(
      {
        input: {
          file: {
            path: missingPath,
            follow: false,
            start_at: "beginning",
          },
        },
        output: {
          capture: {},
        },
      } as PipelineConfig,
      "Cannot stat input file",
    );
  });

  it("converts http input invalid port into BuildError Fail", async () => {
    await expectBuildFailure(
      {
        input: {
          http: {
            port: 65536,
          },
        },
        output: {
          capture: {},
        },
      } as PipelineConfig,
      "Port must be between 1 and 65535",
    );
  });

  it("still builds a valid file input configuration", async () => {
    const dir = await createTempDir();
    const inputPath = path.join(dir, "events.log");
    await fs.writeFile(inputPath, "seed\n", "utf8");

    const exit = await Effect.runPromiseExit(
      buildPipeline({
        input: {
          file: {
            path: inputPath,
            follow: false,
            start_at: "beginning",
          },
        },
        output: {
          capture: {},
        },
      } as PipelineConfig),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.input.name).toBe("file-input");
      if (exit.value.input.close) {
        await Effect.runPromise(exit.value.input.close());
      }
    }
  });

  it("CLI validate prints Fatal error for redis_pubsub construction failure", async () => {
    const dir = await createTempDir();
    const fixturePath = path.join(dir, "bad-redis-pubsub.yaml");
    await fs.writeFile(
      fixturePath,
      `input:
  redis_pubsub:
    url: redis://localhost:6379
output:
  stdout: {}
`,
      "utf8",
    );

    const { code, output } = await runCliValidate(fixturePath);

    expect(code).not.toBe(0);
    expect(output).toContain("Fatal error:");
    expect(output).toContain(
      "Redis Pub/Sub Input requires at least one channel or pattern",
    );
  });
});
