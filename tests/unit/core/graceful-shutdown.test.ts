import { describe, expect, it } from "vitest";
import { Deferred, Effect, Fiber, Stream } from "effect";
import * as S from "effect/Schema";
import { PipelineConfigSchema } from "../../../src/core/config-loader.js";
import { buildPipeline } from "../../../src/core/pipeline-builder.js";
import { makeShutdownController, run } from "../../../src/core/pipeline.js";
import { createMessage } from "../../../src/core/types.js";

describe("graceful pipeline shutdown", () => {
  it("finishes a destructive pull already in progress before stopping", async () => {
    let removed = 0;
    let delivered = 0;
    let acknowledged = 0;

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const pullStarted = yield* Deferred.make<void>();
        const releasePull = yield* Deferred.make<void>();
        const shutdown = yield* makeShutdownController();
        const message = {
          ...createMessage("destructive-pull"),
          ack: () =>
            Effect.sync(() => {
              acknowledged += 1;
            }),
        };
        const stream = Stream.fromEffect(
          Effect.gen(function* () {
            removed += 1;
            yield* Deferred.succeed(pullStarted, undefined);
            yield* Deferred.await(releasePull);
            return message;
          }),
        ).pipe(Stream.concat(Stream.never));
        const fiber = yield* Effect.fork(
          run(
            {
              name: "finish-current-pull-test",
              input: {
                name: "destructive-pull",
                shutdownMode: "finish-current",
                stream,
              },
              processors: [],
              output: {
                name: "capture",
                send: () =>
                  Effect.sync(() => {
                    delivered += 1;
                  }),
              },
            },
            { shutdown, shutdownTimeoutMs: 1_000 },
          ),
        );

        yield* Deferred.await(pullStarted);
        yield* shutdown.request;
        yield* Deferred.succeed(releasePull, undefined);
        return yield* Fiber.join(fiber);
      }),
    );

    expect(removed).toBe(1);
    expect(delivered).toBe(1);
    expect(acknowledged).toBe(1);
    expect(result.shutdown).toBe("graceful");
  });

  it("interrupts a default input without waiting for its current pull", async () => {
    let removed = 0;
    let delivered = 0;

    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const pullStarted = yield* Deferred.make<void>();
        const releasePull = yield* Deferred.make<void>();
        const shutdown = yield* makeShutdownController();
        const stream = Stream.fromEffect(
          Effect.gen(function* () {
            removed += 1;
            yield* Deferred.succeed(pullStarted, undefined);
            yield* Deferred.await(releasePull);
            return createMessage("interruptible-pull");
          }),
        ).pipe(Stream.concat(Stream.never));
        const fiber = yield* Effect.fork(
          run(
            {
              name: "interrupt-pull-test",
              input: { name: "interruptible-pull", stream },
              processors: [],
              output: {
                name: "capture",
                send: () =>
                  Effect.sync(() => {
                    delivered += 1;
                  }),
              },
            },
            { shutdown, shutdownTimeoutMs: 1_000 },
          ),
        );

        yield* Deferred.await(pullStarted);
        yield* shutdown.request;
        const outcome = yield* Effect.race(
          Fiber.join(fiber).pipe(
            Effect.map((result) => ({ _tag: "Result" as const, result })),
          ),
          Effect.sleep("1 second").pipe(
            Effect.as({ _tag: "TimedOut" as const }),
          ),
        );
        if (outcome._tag === "TimedOut") {
          yield* Deferred.succeed(releasePull, undefined);
          yield* shutdown.requestForce;
          yield* Fiber.join(fiber);
        }
        return outcome;
      }),
    );

    expect(outcome._tag).toBe("Result");
    if (outcome._tag === "Result") {
      expect(outcome.result.shutdown).toBe("graceful");
    }
    expect(removed).toBe(1);
    expect(delivered).toBe(0);
  });

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
                getMetrics: () => ({
                  component: "shutdown-input",
                  timestamp: Date.now(),
                  messagesProcessed: 1,
                  messagesDropped: 0,
                  errorsEncountered: 0,
                  averageDuration: 0,
                  totalDuration: 0,
                }),
                stream: Stream.concat(Stream.make(first), Stream.never),
                close: () => Effect.sync(() => events.push("input-close")),
              },
              processors: [],
              output: {
                name: "blocked",
                getMetrics: () => ({
                  component: "shutdown-output",
                  timestamp: Date.now(),
                  messagesSent: events.includes("send-complete") ? 1 : 0,
                  batchesSent: 0,
                  sendErrors: 0,
                  averageDuration: 0,
                  totalDuration: 0,
                }),
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
    expect(result.metrics?.input?.messagesProcessed).toBe(1);
    expect(result.metrics?.output?.messagesSent).toBe(1);
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

  it("preserves processed stats when close exceeds its timeout", async () => {
    const result = await Effect.runPromise(
      run(
        {
          name: "close-timeout-stats-test",
          input: {
            name: "three",
            stream: Stream.make(
              createMessage(1),
              createMessage(2),
              createMessage(3),
            ),
            close: () => Effect.never,
          },
          processors: [],
          output: { name: "success", send: () => Effect.void },
        },
        { shutdownTimeoutMs: 10 },
      ),
    );

    expect(result.success).toBe(false);
    expect(result.shutdown).toBe("timed-out");
    expect(result.stats.processed).toBe(3);
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

  it("allows a force-only shutdown request", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const outputStarted = yield* Deferred.make<void>();
        const shutdown = yield* makeShutdownController();
        const fiber = yield* Effect.fork(
          run(
            {
              name: "force-only-test",
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
            { shutdown, shutdownTimeoutMs: 60_000 },
          ),
        );

        yield* Deferred.await(outputStarted);
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
