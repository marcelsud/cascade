import { describe, expect, it } from "vitest";
import { Effect, Either } from "effect";
import * as Schema from "effect/Schema";
import {
  PipelineConfigSchema,
  type PipelineConfig,
} from "../../../src/core/config-loader.js";
import { buildPipeline } from "../../../src/core/pipeline-builder.js";

const baseConfig = {
  input: {
    generate: {
      count: 1,
      template: { status: "active" },
    },
  },
  output: { capture: {} },
};

const decode = (config: unknown) =>
  Effect.runSync(
    Effect.either(Schema.decodeUnknown(PipelineConfigSchema)(config)),
  );

describe("Filter processor configuration", () => {
  it("accepts a non-empty JSONata check", () => {
    const result = decode({
      ...baseConfig,
      pipeline: { processors: [{ filter: { check: 'status = "active"' } }] },
    });

    expect(Either.isRight(result)).toBe(true);
  });

  it("rejects missing, empty, and blank checks", () => {
    for (const filter of [{}, { check: "" }, { check: "   " }]) {
      const result = decode({
        ...baseConfig,
        pipeline: { processors: [{ filter }] },
      });

      expect(Either.isLeft(result)).toBe(true);
    }
  });

  it("rejects filter combined with another processor", () => {
    const result = decode({
      ...baseConfig,
      pipeline: {
        processors: [
          {
            filter: { check: "true" },
            log: { level: "info" },
          },
        ],
      },
    });

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(String(result.left)).toContain(
        "Processor must configure exactly one component; found: filter, log",
      );
    }
  });

  it("builds a filter processor from decoded configuration", async () => {
    const decoded = decode({
      ...baseConfig,
      pipeline: { processors: [{ filter: { check: "true" } }] },
    });
    if (Either.isLeft(decoded)) throw decoded.left;

    const pipeline = await Effect.runPromise(buildPipeline(decoded.right));

    expect(pipeline.processors).toHaveLength(1);
    expect(pipeline.processors[0].name).toBe("filter-processor");
  });

  it("maps invalid JSONata syntax to BuildError", async () => {
    const config = {
      ...baseConfig,
      pipeline: { processors: [{ filter: { check: "(" } }] },
    } as PipelineConfig;

    const result = await Effect.runPromise(
      Effect.either(buildPipeline(config)),
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("BuildError");
      expect(result.left.message).toContain("Failed to compile filter check");
    }
  });
});
