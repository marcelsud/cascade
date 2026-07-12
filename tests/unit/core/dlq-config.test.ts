import { afterEach, describe, expect, it } from "vitest";
import { Effect, Either } from "effect";
import * as S from "effect/Schema";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as yaml from "yaml";
import {
  PipelineConfigSchema,
  loadConfig,
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
  output: { capture: {} },
};
const tempDirs: string[] = [];

const decode = (config: unknown) =>
  Effect.runSync(Effect.either(S.decodeUnknown(PipelineConfigSchema)(config)));

const expectInvalid = (config: unknown, message?: string) => {
  const result = decode(config);
  expect(Either.isLeft(result)).toBe(true);
  if (message && Either.isLeft(result)) {
    expect(String(result.left)).toContain(message);
  }
};

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

describe("DLQ pipeline configuration", () => {
  it("accepts a DLQ output with the default retry count", () => {
    const result = decode({
      ...baseConfig,
      dlq: { output: { capture: {} } },
    });

    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      expect(result.right.dlq?.max_retries).toBeUndefined();
    }
  });

  it.each([
    ["0", 0],
    ["1", 1],
    ["5", 5],
  ])("accepts max_retries=%s", (_, maxRetries) => {
    const result = decode({
      ...baseConfig,
      dlq: {
        max_retries: maxRetries,
        output: { capture: {} },
      },
    });

    expect(Either.isRight(result)).toBe(true);
  });

  it.each([
    ["-1", -1],
    ["1.5", 1.5],
    ['"3"', "3"],
  ])("rejects max_retries=%s", (_, maxRetries) => {
    expectInvalid({
      ...baseConfig,
      dlq: {
        max_retries: maxRetries,
        output: { capture: {} },
      },
    });
  });

  it("rejects a DLQ without an output", () => {
    expectInvalid({ ...baseConfig, dlq: { max_retries: 3 } });
  });

  it("rejects misspelled DLQ fields when loading YAML", async () => {
    const result = await loadYamlConfig({
      ...baseConfig,
      dlq: {
        max_retrys: 5,
        output: { capture: {} },
      },
    });

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.message).toContain("max_retrys");
      expect(result.left.message).toContain("is unexpected");
    }
  });

  it("rejects an empty DLQ output", () => {
    expectInvalid(
      { ...baseConfig, dlq: { output: {} } },
      "Output must configure exactly one component; found: none",
    );
  });

  it("rejects multiple DLQ output components", () => {
    expectInvalid(
      {
        ...baseConfig,
        dlq: {
          output: {
            capture: {},
            http: { url: "https://example.com" },
          },
        },
      },
      "Output must configure exactly one component; found: capture, http",
    );
  });

  it("leaves the primary output unchanged without DLQ configuration", async () => {
    const config = await Effect.runPromise(
      S.decodeUnknown(PipelineConfigSchema)(baseConfig),
    );
    const pipeline = await Effect.runPromise(buildPipeline(config));

    expect(pipeline.output.name).toBe("capture-output");
  });

  it("wraps the primary output when DLQ configuration is present", async () => {
    const config = await Effect.runPromise(
      S.decodeUnknown(PipelineConfigSchema)({
        ...baseConfig,
        dlq: {
          max_retries: 0,
          output: { capture: {} },
        },
      }),
    );
    const pipeline = await Effect.runPromise(buildPipeline(config));

    expect(pipeline.output.name).toBe("capture-output-with-dlq");
    expect(pipeline.output.close).toBeDefined();
  });

  it("runs a successful pipeline through the DLQ-wrapped output", async () => {
    const config = await Effect.runPromise(
      S.decodeUnknown(PipelineConfigSchema)({
        input: {
          generate: {
            count: 3,
            template: { id: "{{index}}" },
          },
        },
        output: { capture: {} },
        dlq: {
          max_retries: 0,
          output: { capture: {} },
        },
      }),
    );
    const pipeline = await Effect.runPromise(buildPipeline(config));
    const result = await Effect.runPromise(run(pipeline));

    expect(result.success).toBe(true);
    expect(result.stats.processed).toBe(3);
    expect(result.stats.failed).toBe(0);
  });

  it("forwards a failed HTTP output to the configured DLQ", async () => {
    const config = await Effect.runPromise(
      S.decodeUnknown(PipelineConfigSchema)({
        input: {
          generate: {
            count: 1,
            template: { value: "test" },
          },
        },
        output: {
          http: {
            url: "http://127.0.0.1:1/primary",
            timeout: 100,
            max_retries: 0,
          },
        },
        dlq: {
          max_retries: 0,
          output: {
            capture: {},
          },
        },
      }),
    );
    const pipeline = await Effect.runPromise(buildPipeline(config));
    const result = await Effect.runPromise(run(pipeline));

    expect(result.success).toBe(true);
    expect(result.stats.processed).toBe(1);
    expect(result.stats.failed).toBe(0);
  });

  it("loads the documented DLQ example", async () => {
    const config = await Effect.runPromise(
      loadConfig("configs/dlq-example.yaml"),
    );

    expect(config.pipeline?.processors).toHaveLength(2);
    expect(config.dlq?.max_retries).toBe(3);
    expect(config.dlq?.output.aws_sqs?.url).toContain("dlq-queue");
  });
});
