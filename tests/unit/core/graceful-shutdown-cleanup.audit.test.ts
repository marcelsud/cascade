import { describe, expect, it } from "vitest";
import { Deferred, Effect, Fiber, Stream } from "effect";
import {
  makeShutdownController,
  run,
  type PipelineShutdownController,
} from "../../../src/core/pipeline.js";
import { createMessage } from "../../../src/core/types.js";

describe("graceful shutdown resource cleanup on force/timeout", () => {
  it.each([
    {
      mode: "forced" as const,
      trigger: async (shutdown: PipelineShutdownController) => {
        await Effect.runPromise(shutdown.request);
        await Effect.runPromise(shutdown.requestForce);
      },
      expectedShutdown: "forced" as const,
    },
    {
      mode: "timed-out" as const,
      trigger: async (shutdown: PipelineShutdownController) => {
        await Effect.runPromise(shutdown.request);
      },
      expectedShutdown: "timed-out" as const,
    },
  ])(
    "closes input and output exactly once after $mode shutdown of a blocked worker",
    async ({ mode, trigger, expectedShutdown }) => {
      let inputClosed = 0;
      let outputClosed = 0;
      const closeOrder: string[] = [];

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const outputStarted = yield* Deferred.make<void>();
          const shutdown = yield* makeShutdownController();
          const fiber = yield* Effect.fork(
            run(
              {
                name: `shutdown-cleanup-${mode}`,
                input: {
                  name: "one",
                  stream: Stream.make(createMessage(1)),
                  close: () =>
                    Effect.sync(() => {
                      inputClosed += 1;
                      closeOrder.push("input");
                    }),
                },
                processors: [],
                output: {
                  name: "blocked",
                  send: () =>
                    Deferred.succeed(outputStarted, undefined).pipe(
                      Effect.zipRight(Effect.never),
                    ),
                  close: () =>
                    Effect.sync(() => {
                      outputClosed += 1;
                      closeOrder.push("output");
                    }),
                },
              },
              {
                shutdown,
                shutdownTimeoutMs: mode === "timed-out" ? 10 : 1_000,
              },
            ),
          );

          yield* Deferred.await(outputStarted);
          yield* Effect.promise(() => trigger(shutdown));
          return yield* Fiber.join(fiber);
        }),
      );

      expect(result.success).toBe(false);
      expect(result.shutdown).toBe(expectedShutdown);
      expect(inputClosed).toBe(1);
      expect(outputClosed).toBe(1);
      expect(closeOrder).toEqual(["input", "output"]);
    },
  );

  it("closes input and output exactly once when force races timeout", async () => {
    let inputCloseEntries = 0;
    let inputClosed = 0;
    let outputClosed = 0;

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const outputStarted = yield* Deferred.make<void>();
        const shutdown = yield* makeShutdownController();
        const fiber = yield* Effect.fork(
          run(
            {
              name: "shutdown-cleanup-force-timeout-race",
              input: {
                name: "one",
                stream: Stream.make(createMessage(1)),
                // Slow enough that a second concurrent force/timeout arm can
                // enter ensureClose before the first flight finishes.
                close: () =>
                  Effect.sync(() => {
                    inputCloseEntries += 1;
                  }).pipe(
                    Effect.zipRight(Effect.sleep("60 millis")),
                    Effect.zipRight(
                      Effect.sync(() => {
                        inputClosed += 1;
                      }),
                    ),
                  ),
              },
              processors: [],
              output: {
                name: "blocked",
                send: () =>
                  Deferred.succeed(outputStarted, undefined).pipe(
                    Effect.zipRight(Effect.never),
                  ),
                close: () =>
                  Effect.sync(() => {
                    outputClosed += 1;
                  }),
              },
            },
            { shutdown, shutdownTimeoutMs: 100 },
          ),
        );

        yield* Deferred.await(outputStarted);
        yield* shutdown.request;
        // Force near the graceful deadline so timeout may also enter cleanup.
        yield* Effect.sleep("70 millis");
        yield* shutdown.requestForce;
        return yield* Fiber.join(fiber);
      }),
    );

    expect(result.success).toBe(false);
    expect(["forced", "timed-out"]).toContain(result.shutdown);
    expect(inputCloseEntries).toBe(1);
    expect(inputClosed).toBe(1);
    expect(outputClosed).toBe(1);
  });
});
