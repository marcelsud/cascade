import { afterEach, describe, expect, it } from "vitest";
import { Effect, Either, Stream } from "effect";
import * as Schema from "effect/Schema";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  ComponentRegistrationError,
  createComponentRegistry,
} from "../../../src/core/component-registry.js";
import {
  ConfigValidationError,
  createPipelineConfigSchema,
  loadConfig,
} from "../../../src/core/config-loader.js";
import { buildPipeline } from "../../../src/core/pipeline-builder.js";
import { run } from "../../../src/core/pipeline.js";
import { createMessage, type Message } from "../../../src/core/types.js";

const createdPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    createdPaths
      .splice(0)
      .map((target) => fs.rm(target, { recursive: true, force: true })),
  );
});

describe("ComponentRegistry", () => {
  it("runs custom input, processor, and output components end to end", async () => {
    const captured: Message[] = [];
    const registry = createComponentRegistry()
      .registerInput({
        name: "values",
        schema: Schema.Struct({ values: Schema.Array(Schema.String) }),
        build: (config) =>
          Effect.succeed({
            name: "values-input",
            stream: Stream.fromIterable(
              config.values.map((value) => createMessage(value)),
            ),
          }),
      })
      .registerProcessor({
        name: "suffix",
        schema: Schema.Struct({ value: Schema.String }),
        build: (config) =>
          Effect.succeed({
            name: "suffix-processor",
            process: (message) =>
              Effect.succeed({
                ...message,
                content: `${String(message.content)}${config.value}`,
              }),
          }),
      })
      .registerOutput({
        name: "collect",
        schema: Schema.Struct({}),
        build: () =>
          Effect.succeed({
            name: "collect-output",
            send: (message) =>
              Effect.sync(() => {
                captured.push(message);
              }),
          }),
      });

    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "cascade-registry-"),
    );
    createdPaths.push(directory);
    const configPath = path.join(directory, "pipeline.yaml");
    await fs.writeFile(
      configPath,
      `input:
  values:
    values: [hello, world]
pipeline:
  processors:
    - branch:
        processors:
          - suffix:
              value: "!"
output:
  collect: {}
dlq:
  max_retries: 0
  output:
    collect: {}
`,
      "utf8",
    );

    const config = await Effect.runPromise(loadConfig(configPath, registry));
    const pipeline = await Effect.runPromise(
      buildPipeline(config, false, registry),
    );
    const result = await Effect.runPromise(run(pipeline));

    expect(result.success).toBe(true);
    expect(captured.map((message) => message.content)).toEqual([
      "hello",
      "world",
    ]);
    expect(
      captured.map(
        (message) =>
          (message.metadata.branchResult as { content: unknown }).content,
      ),
    ).toEqual(["hello!", "world!"]);
  });

  it("validates registered component configuration", () => {
    const registry = createComponentRegistry().registerProcessor({
      name: "suffix",
      schema: Schema.Struct({ value: Schema.String }),
      build: () =>
        Effect.succeed({
          name: "suffix",
          process: (message) => Effect.succeed(message),
        }),
    });
    const schema = createPipelineConfigSchema(registry);
    const result = Schema.decodeUnknownEither(schema)({
      input: { generate: { count: 1, template: {} } },
      pipeline: { processors: [{ suffix: { value: 42 } }] },
      output: { capture: {} },
    });

    expect(result._tag).toBe("Left");
  });

  it("rejects duplicate registrations within a component kind", () => {
    const registry = createComponentRegistry().registerProcessor({
      name: "custom",
      schema: Schema.Struct({}),
      build: () =>
        Effect.succeed({
          name: "custom",
          process: (message) => Effect.succeed(message),
        }),
    });

    expect(() =>
      registry.registerProcessor({
        name: "custom",
        schema: Schema.Struct({}),
        build: () =>
          Effect.succeed({
            name: "custom",
            process: (message) => Effect.succeed(message),
          }),
      }),
    ).toThrow(ComponentRegistrationError);
  });

  it("rejects attempts to replace built-in component names", () => {
    const registry = createComponentRegistry().registerOutput({
      name: "http",
      schema: Schema.Struct({}),
      build: () =>
        Effect.succeed({ name: "custom-http", send: () => Effect.void }),
    });

    expect(() => createPipelineConfigSchema(registry)).toThrow(
      "the name is reserved by a built-in component",
    );
  });

  it("returns registration conflicts through loadConfig's error channel", async () => {
    const registry = createComponentRegistry().registerOutput({
      name: "http",
      schema: Schema.Struct({}),
      build: () =>
        Effect.succeed({ name: "custom-http", send: () => Effect.void }),
    });
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "cascade-registry-"),
    );
    createdPaths.push(directory);
    const configPath = path.join(directory, "pipeline.yaml");
    await fs.writeFile(
      configPath,
      "input:\n  generate:\n    count: 1\n    template: {}\noutput:\n  capture: {}\n",
      "utf8",
    );

    const result = await Effect.runPromise(
      Effect.either(loadConfig(configPath, registry)),
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(ConfigValidationError);
      expect(result.left.message).toContain(
        "the name is reserved by a built-in component",
      );
    }
  });

  it("names a custom component when buildPipeline is missing its registry", async () => {
    const registry = createComponentRegistry().registerInput({
      name: "values",
      schema: Schema.Struct({ values: Schema.Array(Schema.String) }),
      build: (config) =>
        Effect.succeed({
          name: "values-input",
          stream: Stream.fromIterable(config.values.map(createMessage)),
        }),
    });
    const schema = createPipelineConfigSchema(registry);
    const config = Schema.decodeUnknownSync(schema)({
      input: { values: { values: ["test"] } },
      output: { capture: {} },
    });

    const result = await Effect.runPromise(
      Effect.either(buildPipeline(config)),
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.message).toBe(
        "Unknown input component 'values' — is the registry passed to buildPipeline?",
      );
    }
  });

  it("rejects component names with surrounding whitespace", () => {
    expect(() =>
      createComponentRegistry().registerProcessor({
        name: " custom ",
        schema: Schema.Struct({}),
        build: () =>
          Effect.succeed({
            name: "custom",
            process: (message) => Effect.succeed(message),
          }),
      }),
    ).toThrow("names must not have leading or trailing whitespace");
  });

  it("keeps registries isolated", () => {
    const first = createComponentRegistry().registerProcessor({
      name: "custom",
      schema: Schema.Struct({}),
      build: () =>
        Effect.succeed({
          name: "custom",
          process: (message) => Effect.succeed(message),
        }),
    });
    const second = createComponentRegistry();

    expect(first.getProcessor("custom")).toBeDefined();
    expect(second.getProcessor("custom")).toBeUndefined();
  });
});
