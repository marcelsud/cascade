import { describe, expect, it } from "vitest";
import { Effect, Either } from "effect";
import * as S from "effect/Schema";
import { PipelineConfigSchema } from "../../../src/core/config-loader.js";
import { buildPipeline } from "../../../src/core/pipeline-builder.js";

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
