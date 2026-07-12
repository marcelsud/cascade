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

const validInput = {
  generate: {
    count: 1,
    template: { value: "test" },
  },
};

const validOutput = { capture: {} };
const tempDirs: string[] = [];

const decode = (config: unknown) =>
  Effect.runSync(Effect.either(S.decodeUnknown(PipelineConfigSchema)(config)));

const expectValidationError = (config: unknown, message: string) => {
  const result = decode(config);

  expect(Either.isLeft(result)).toBe(true);
  if (Either.isLeft(result)) {
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

describe("component selection validation", () => {
  it("accepts exactly one input, processor, and output component", () => {
    const result = decode({
      input: validInput,
      pipeline: { processors: [{ log: { level: "info" } }] },
      output: validOutput,
    });

    expect(Either.isRight(result)).toBe(true);
  });

  it("rejects an input with no component", () => {
    expectValidationError(
      { input: {}, output: validOutput },
      "Input must configure exactly one component; found: none",
    );
  });

  it("hints at unknown component names when loading YAML", async () => {
    const result = await loadYamlConfig({
      input: { kafka: { brokers: ["localhost:9092"] } },
      output: validOutput,
    });

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.message).toContain(
        "Input must configure exactly one component; found: none — check for unknown or misspelled component names",
      );
    }
  });

  it("rejects multiple input components and names them", () => {
    // If either component payload is invalid, its field error may take
    // precedence over this selection conflict.
    expectValidationError(
      {
        input: { ...validInput, stdin: {} },
        output: validOutput,
      },
      "Input must configure exactly one component; found: generate, stdin",
    );
  });

  it("rejects an output with no component", () => {
    expectValidationError(
      { input: validInput, output: {} },
      "Output must configure exactly one component; found: none",
    );
  });

  it("rejects multiple output components and names them", () => {
    expectValidationError(
      {
        input: validInput,
        output: {
          capture: {},
          http: { url: "https://example.com" },
        },
      },
      "Output must configure exactly one component; found: capture, http",
    );
  });

  it("rejects a processor entry with no component", () => {
    expectValidationError(
      {
        input: validInput,
        pipeline: { processors: [{}] },
        output: validOutput,
      },
      "Processor must configure exactly one component; found: none",
    );
  });

  it("rejects multiple processor components and names them", () => {
    expectValidationError(
      {
        input: validInput,
        pipeline: {
          processors: [
            {
              log: { level: "info" },
              uppercase: { fields: ["name"] },
            },
          ],
        },
        output: validOutput,
      },
      "Processor must configure exactly one component; found: log, uppercase",
    );
  });

  it("validates processors nested inside a branch", () => {
    expectValidationError(
      {
        input: validInput,
        pipeline: {
          processors: [{ branch: { processors: [{}] } }],
        },
        output: validOutput,
      },
      "Processor must configure exactly one component; found: none",
    );
  });

  it("validates processors nested inside switch cases", () => {
    expectValidationError(
      {
        input: validInput,
        pipeline: {
          processors: [
            {
              switch: {
                cases: [
                  {
                    check: "true",
                    processors: [
                      {
                        metadata: {},
                        log: { level: "info" },
                      },
                    ],
                  },
                ],
              },
            },
          ],
        },
        output: validOutput,
      },
      "Processor must configure exactly one component; found: log, metadata",
    );
  });
});
