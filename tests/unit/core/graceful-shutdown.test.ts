import { describe, expect, it } from "vitest";
import { Deferred, Effect, Fiber, Stream } from "effect";
import * as S from "effect/Schema";
import { PipelineConfigSchema } from "../../../src/core/config-loader.js";
import { buildPipeline } from "../../../src/core/pipeline-builder.js";
import { makeShutdownController, run } from "../../../src/core/pipeline.js";
import { createMessage } from "../../../src/core/types.js";

describe("graceful pipeline shutdown", () => {
  it("stops intake, drains in-flight delivery and acknowledgement, then closes", async () => {
    const events: string[] = [];
    let acknowledgements = 0;

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const outputStarted = yield* Deferred.make<void>();
        const releaseOutput = yield* Deferred.make<void>();
        const shutdown = yield* makeShutdownController();
        const first = {
          ...createMessage("first"),
          ack: () =>
            Effect.sync(() => {
              acknowledgements += 1;
              events.push("ack");
            }),
        };

        const fiber = yield* Effect.fork(
          run(
            {
              name: "drain-test",
              input: {
                name: "two-messages",
                stream: Stream.concat(Stream.make(first), Stream.never),
                close: () => Effect.sync(() => events.push("input-close")),
              },
              processors: [],
              output: {
                name: "blocked",
                send: (message) =>
                  Effect.gen(function* () {
                    events.push(`send:${String(message.content)}`);
                    yield* Deferred.succeed(outputStarted, undefined);
                    yield* Deferred.await(releaseOutput);
                    events.push("send-complete");
                  }),
                close: () => Effect.sync(() => events.push("output-close")),
              },
              backpressure: { maxConcurrentMessages: 1 },
            },
            { shutdown, shutdownTimeoutMs: 1_000 },
          ),
        );

        yield* Deferred.await(outputStarted);
        yield* shutdown.request;
        yield* Deferred.succeed(releaseOutput, undefined);
        return yield* Fiber.join(fiber);
      }),
    );

    expect(result.success).toBe(true);
    expect(result.shutdown).toBe("graceful");
    expect(acknowledgements).toBe(1);
    expect(events).toEqual([
      "send:first",
      "send-complete",
      "ack",
      "input-close",
      "output-close",
    ]);
  });

  it("returns a non-clean result when close exceeds its timeout", async () => {
    const result = await Effect.runPromise(
      run(
        {
          name: "close-timeout-test",
          input: {
            name: "empty",
            stream: Stream.empty,
            close: () => Effect.never,
          },
          processors: [],
          output: { name: "unused", send: () => Effect.void },
        },
        { shutdownTimeoutMs: 10 },
      ),
    );

    expect(result.success).toBe(false);
    expect(result.shutdown).toBe("timed-out");
  });

  it("forces an in-progress drain after a second shutdown request", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const outputStarted = yield* Deferred.make<void>();
        const shutdown = yield* makeShutdownController();
        const fiber = yield* Effect.fork(
          run(
            {
              name: "force-test",
              input: { name: "one", stream: Stream.make(createMessage(1)) },
              processors: [],
              output: {
                name: "blocked",
                send: () =>
                  Deferred.succeed(outputStarted, undefined).pipe(
                    Effect.zipRight(Effect.never),
                  ),
              },
            },
            { shutdown, shutdownTimeoutMs: 1_000 },
          ),
        );

        yield* Deferred.await(outputStarted);
        yield* shutdown.request;
        yield* shutdown.requestForce;
        return yield* Fiber.join(fiber);
      }),
    );

    expect(result.success).toBe(false);
    expect(result.shutdown).toBe("forced");
  });

  it("validates and maps shutdown_timeout_ms", async () => {
    const config = await Effect.runPromise(
      S.decodeUnknown(PipelineConfigSchema)({
        input: { generate: { count: 1, template: { value: "test" } } },
        output: { capture: {} },
        shutdown_timeout_ms: 2_500,
      }),
    );
    const pipeline = await Effect.runPromise(buildPipeline(config));
    expect(pipeline.shutdownTimeoutMs).toBe(2_500);

    const invalid = await Effect.runPromise(
      Effect.either(
        S.decodeUnknown(PipelineConfigSchema)({
          input: { generate: { count: 1, template: { value: "test" } } },
          output: { capture: {} },
          shutdown_timeout_ms: 0,
        }),
      ),
    );
    expect(invalid._tag).toBe("Left");
  });
});
