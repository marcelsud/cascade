import { afterEach, describe, expect, it } from "vitest";
import { Effect, Either } from "effect";
import * as S from "effect/Schema";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as yaml from "yaml";
import {
  loadConfig,
  PipelineConfigSchema,
} from "../../../src/core/config-loader.js";
import { buildPipeline } from "../../../src/core/pipeline-builder.js";
import { run } from "../../../src/core/pipeline.js";

const baseConfig = {
  input: {
    generate: {
      count: 1,
      template: { value: "test" },
    },
  },
  output: {
    capture: {},
  },
};

const tempDirs: string[] = [];

const loadYamlConfig = async (config: unknown) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cascade-config-"));
  tempDirs.push(dir);
  const configPath = path.join(dir, "config.yaml");
  await fs.writeFile(configPath, yaml.stringify(config), "utf8");
  return Effect.runPromise(Effect.either(loadConfig(configPath)));
};

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true })),
  );
});

describe("pipeline backpressure configuration", () => {
  it("maps YAML-style fields to the runtime pipeline", async () => {
    const config = await Effect.runPromise(
      S.decodeUnknown(PipelineConfigSchema)({
        ...baseConfig,
        pipeline: {
          backpressure: {
            max_concurrent_messages: 12,
            max_concurrent_outputs: 4,
          },
        },
      }),
    );

    const pipeline = await Effect.runPromise(buildPipeline(config));

    expect(pipeline.backpressure).toEqual({
      maxConcurrentMessages: 12,
      maxConcurrentOutputs: 4,
    });
  });

  it("leaves backpressure unset when it is not configured", async () => {
    const config = await Effect.runPromise(
      S.decodeUnknown(PipelineConfigSchema)(baseConfig),
    );

    const pipeline = await Effect.runPromise(buildPipeline(config));

    expect(pipeline.backpressure).toBeUndefined();
  });

  it("uses the runtime output concurrency default for partial config", async () => {
    const config = await Effect.runPromise(
      S.decodeUnknown(PipelineConfigSchema)({
        ...baseConfig,
        pipeline: {
          backpressure: {
            max_concurrent_messages: 12,
          },
        },
      }),
    );

    const pipeline = await Effect.runPromise(buildPipeline(config));

    expect(pipeline.backpressure).toEqual({
      maxConcurrentMessages: 12,
      maxConcurrentOutputs: undefined,
    });

    let activeOutputs = 0;
    let maxActiveOutputs = 0;
    const result = await Effect.runPromise(
      run({
        ...pipeline,
        processors: [
          {
            name: "fan-out",
            process: (message) =>
              Effect.succeed(
                Array.from({ length: 10 }, (_, index) => ({
                  ...message,
                  id: `${message.id}-${index}`,
                })),
              ),
          },
        ],
        output: {
          name: "concurrency-probe",
          send: () =>
            Effect.gen(function* () {
              activeOutputs += 1;
              maxActiveOutputs = Math.max(maxActiveOutputs, activeOutputs);
              yield* Effect.sleep("10 millis");
              activeOutputs -= 1;
            }),
        },
      }),
    );

    expect(result.success).toBe(true);
    expect(maxActiveOutputs).toBe(5);
  });

  it("collapses an empty backpressure object to undefined", async () => {
    const config = await Effect.runPromise(
      S.decodeUnknown(PipelineConfigSchema)({
        ...baseConfig,
        pipeline: { backpressure: {} },
      }),
    );

    const pipeline = await Effect.runPromise(buildPipeline(config));

    expect(pipeline.backpressure).toBeUndefined();
  });

  it("rejects misplaced top-level processors when loading YAML", async () => {
    const result = await loadYamlConfig({
      ...baseConfig,
      processors: [{ log: { level: "info" } }],
    });

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.message).toContain('is unexpected, expected: "input"');
    }
  });

  it("rejects typos in the backpressure envelope", async () => {
    const result = await loadYamlConfig({
      ...baseConfig,
      pipeline: {
        backpressure: { max_concurent_messages: 12 },
      },
    });

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.message).toContain("max_concurent_messages");
      expect(result.left.message).toContain("is unexpected");
    }
  });

  it.each([
    ["max_concurrent_messages=0", "max_concurrent_messages", 0],
    ["max_concurrent_messages=-1", "max_concurrent_messages", -1],
    ["max_concurrent_messages=1.5", "max_concurrent_messages", 1.5],
    ["max_concurrent_outputs=0", "max_concurrent_outputs", 0],
    ["max_concurrent_outputs=-1", "max_concurrent_outputs", -1],
    ["max_concurrent_outputs=1.5", "max_concurrent_outputs", 1.5],
  ])("rejects invalid %s", async (_, field, value) => {
    const result = await Effect.runPromise(
      Effect.either(
        S.decodeUnknown(PipelineConfigSchema)({
          ...baseConfig,
          pipeline: {
            backpressure: {
              [field]: value,
            },
          },
        }),
      ),
    );

    expect(Either.isLeft(result)).toBe(true);
  });
});
