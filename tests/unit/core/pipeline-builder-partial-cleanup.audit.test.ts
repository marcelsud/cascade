import { describe, expect, it } from "vitest";
import { Cause, Effect, Exit, Option, Stream } from "effect";
import * as Schema from "effect/Schema";
import { createComponentRegistry } from "../../../src/core/component-registry.js";
import type { PipelineConfig } from "../../../src/core/config-loader.js";
import {
  BuildError,
  buildPipeline,
} from "../../../src/core/pipeline-builder.js";

const expectBuildError = async (
  config: PipelineConfig,
  registry: ReturnType<typeof createComponentRegistry>,
  message: string,
) => {
  const exit = await Effect.runPromiseExit(
    buildPipeline(config, false, registry),
  );

  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    expect(Option.isNone(Cause.dieOption(exit.cause))).toBe(true);
    const failure = Option.getOrThrow(Cause.failureOption(exit.cause));
    expect(failure).toBeInstanceOf(BuildError);
    expect(failure.message).toContain(message);
  }
};

describe("pipeline-builder partial construction cleanup", () => {
  it("closes the input when primary output construction fails", async () => {
    let inputCloseCount = 0;
    const registry = createComponentRegistry()
      .registerInput({
        name: "tracked_input",
        schema: Schema.Struct({}),
        build: () =>
          Effect.succeed({
            name: "tracked-input",
            stream: Stream.empty,
            close: () =>
              Effect.sync(() => {
                inputCloseCount += 1;
              }),
          }),
      })
      .registerOutput({
        name: "failing_output",
        schema: Schema.Struct({ message: Schema.String }),
        build: ({ message }) => Effect.fail(new Error(message)),
      });

    await expectBuildError(
      {
        input: { tracked_input: {} },
        output: { failing_output: { message: "primary build failed" } },
      } as PipelineConfig,
      registry,
      "primary build failed",
    );

    expect(inputCloseCount).toBe(1);
  });

  it("closes the primary output and input without masking a DLQ build failure", async () => {
    let inputCloseCount = 0;
    let primaryCloseCount = 0;
    const registry = createComponentRegistry()
      .registerInput({
        name: "tracked_input",
        schema: Schema.Struct({}),
        build: () =>
          Effect.succeed({
            name: "tracked-input",
            stream: Stream.empty,
            close: () =>
              Effect.sync(() => {
                inputCloseCount += 1;
              }).pipe(
                Effect.andThen(Effect.die(new Error("input close failed"))),
              ),
          }),
      })
      .registerOutput({
        name: "tracked_output",
        schema: Schema.Struct({}),
        build: () =>
          Effect.succeed({
            name: "tracked-output",
            send: () => Effect.void,
            close: () =>
              Effect.sync(() => {
                primaryCloseCount += 1;
              }).pipe(
                Effect.andThen(Effect.fail(new Error("output close failed"))),
              ),
          }),
      })
      .registerOutput({
        name: "failing_output",
        schema: Schema.Struct({ message: Schema.String }),
        build: ({ message }) => Effect.fail(new Error(message)),
      });

    await expectBuildError(
      {
        input: { tracked_input: {} },
        output: { tracked_output: {} },
        dlq: {
          output: { failing_output: { message: "DLQ build failed" } },
        },
      } as PipelineConfig,
      registry,
      "DLQ build failed",
    );

    expect(primaryCloseCount).toBe(1);
    expect(inputCloseCount).toBe(1);
  });
});
