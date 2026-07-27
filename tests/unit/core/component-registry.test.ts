import { afterEach, describe, expect, it } from "vitest";
import { Cause, Effect, Either, Exit, Option, Stream } from "effect";
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
import {
  BuildError,
  buildPipeline,
} from "../../../src/core/pipeline-builder.js";
import { run } from "../../../src/core/pipeline.js";
import { createMessage, type Message } from "../../../src/core/types.js";
import { createAssertProcessor } from "../../../src/testing/assert-processor.js";

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

  it("maps synchronous throws from registered assert wrappers to BuildError Fail", async () => {
    const registry = createComponentRegistry().registerProcessor({
      name: "assert_wrap",
      schema: Schema.Struct({
        child: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
      }),
      build: (config) =>
        Effect.succeed(createAssertProcessor(config.child as never)),
    });
    const schema = createPipelineConfigSchema(registry);
    const config = Schema.decodeUnknownSync(schema)({
      input: { generate: { count: 1, template: { value: "test" } } },
      pipeline: { processors: [{ assert_wrap: { child: {} } }] },
      output: { capture: {} },
    });

    const exit = await Effect.runPromiseExit(
      buildPipeline(config, false, registry),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Option.isSome(Cause.failureOption(exit.cause))).toBe(true);
      expect(Option.isNone(Cause.dieOption(exit.cause))).toBe(true);

      const failure = Option.getOrThrow(Cause.failureOption(exit.cause));
      expect(failure).toBeInstanceOf(BuildError);
      expect(failure.message).toContain(
        "Failed to build registered component 'assert_wrap'",
      );
      expect(failure.message).toContain("Assert Processor");
      expect(failure.message).toContain(
        "at least one non-blank 'hasFields' path",
      );
    }
  });

  it("preserves nested BuildError diagnostics from context.buildProcessor", async () => {
    const registry = createComponentRegistry().registerProcessor({
      name: "assert_via_context",
      schema: Schema.Struct({
        child: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
      }),
      build: (config, context) =>
        context.buildProcessor({ assert: config.child }),
    });
    const schema = createPipelineConfigSchema(registry);
    const config = Schema.decodeUnknownSync(schema)({
      input: { generate: { count: 1, template: { value: "test" } } },
      pipeline: { processors: [{ assert_via_context: { child: {} } }] },
      output: { capture: {} },
    });

    const exit = await Effect.runPromiseExit(
      buildPipeline(config, false, registry),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Option.isSome(Cause.failureOption(exit.cause))).toBe(true);
      expect(Option.isNone(Cause.dieOption(exit.cause))).toBe(true);

      const failure = Option.getOrThrow(Cause.failureOption(exit.cause));
      expect(failure).toBeInstanceOf(BuildError);
      expect(failure.message).toContain(
        "Failed to build registered component 'assert_via_context'",
      );
      expect(failure.message).toContain("Assert Processor");
      expect(failure.message).toContain(
        "at least one non-blank 'hasFields' path",
      );
      expect(failure.message).not.toContain("[object Object]");
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

  it("rejects empty and whitespace-only component names", () => {
    const emptyBuild = {
      schema: Schema.Struct({}),
      build: () =>
        Effect.succeed({
          name: "unused",
          stream: Stream.empty,
        }),
    };

    for (const name of ["", "   ", "\t"]) {
      expect(() =>
        createComponentRegistry().registerInput({ name, ...emptyBuild }),
      ).toThrow(ComponentRegistrationError);
      expect(() =>
        createComponentRegistry().registerProcessor({
          name,
          schema: Schema.Struct({}),
          build: () =>
            Effect.succeed({
              name: "unused",
              process: (message) => Effect.succeed(message),
            }),
        }),
      ).toThrow(ComponentRegistrationError);
      expect(() =>
        createComponentRegistry().registerOutput({
          name,
          schema: Schema.Struct({}),
          build: () =>
            Effect.succeed({ name: "unused", send: () => Effect.void }),
        }),
      ).toThrow(ComponentRegistrationError);
    }
  });

  it("returns undefined for unknown component lookups", () => {
    const registry = createComponentRegistry();

    expect(registry.getInput("missing")).toBeUndefined();
    expect(registry.getProcessor("missing")).toBeUndefined();
    expect(registry.getOutput("missing")).toBeUndefined();
  });

  it("returns schemas only for the requested kind", () => {
    const inputSchema = Schema.Struct({ values: Schema.Array(Schema.String) });
    const processorSchema = Schema.Struct({ flag: Schema.Boolean });
    const outputSchema = Schema.Struct({ target: Schema.String });

    const registry = createComponentRegistry()
      .registerInput({
        name: "values",
        schema: inputSchema,
        build: () =>
          Effect.succeed({
            name: "values",
            stream: Stream.empty,
          }),
      })
      .registerProcessor({
        name: "flag",
        schema: processorSchema,
        build: () =>
          Effect.succeed({
            name: "flag",
            process: (message) => Effect.succeed(message),
          }),
      })
      .registerOutput({
        name: "target",
        schema: outputSchema,
        build: () =>
          Effect.succeed({ name: "target", send: () => Effect.void }),
      });

    expect(registry.getSchemas("input")).toEqual({ values: inputSchema });
    expect(registry.getSchemas("processor")).toEqual({ flag: processorSchema });
    expect(registry.getSchemas("output")).toEqual({ target: outputSchema });
    expect(createComponentRegistry().getSchemas("input")).toEqual({});
    expect(createComponentRegistry().getSchemas("processor")).toEqual({});
    expect(createComponentRegistry().getSchemas("output")).toEqual({});
  });

  it("allows the same name across kinds but not within one kind", () => {
    const registry = createComponentRegistry()
      .registerInput({
        name: "shared",
        schema: Schema.Struct({}),
        build: () =>
          Effect.succeed({
            name: "shared-input",
            stream: Stream.empty,
          }),
      })
      .registerOutput({
        name: "shared",
        schema: Schema.Struct({}),
        build: () =>
          Effect.succeed({ name: "shared-output", send: () => Effect.void }),
      });

    expect(registry.getInput("shared")?.name).toBe("shared");
    expect(registry.getOutput("shared")?.name).toBe("shared");

    expect(() =>
      registry.registerInput({
        name: "shared",
        schema: Schema.Struct({}),
        build: () =>
          Effect.succeed({
            name: "shared-input-2",
            stream: Stream.empty,
          }),
      }),
    ).toThrow(ComponentRegistrationError);
  });

  it("assertNoConflicts throws only on reserved overlaps", () => {
    const registry = createComponentRegistry().registerInput({
      name: "http",
      schema: Schema.Struct({}),
      build: () =>
        Effect.succeed({
          name: "http",
          stream: Stream.empty,
        }),
    });

    expect(() =>
      registry.assertNoConflicts("input", new Set(["http"])),
    ).toThrow("the name is reserved by a built-in component");

    expect(() =>
      registry.assertNoConflicts("input", new Set(["generate", "sqs"])),
    ).not.toThrow();
  });

  it("createComponentRegistry returns a fresh empty instance", () => {
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

    expect(first).not.toBe(second);
    expect(second.getSchemas("input")).toEqual({});
    expect(second.getSchemas("processor")).toEqual({});
    expect(second.getSchemas("output")).toEqual({});
    expect(second.getProcessor("custom")).toBeUndefined();
  });
});
