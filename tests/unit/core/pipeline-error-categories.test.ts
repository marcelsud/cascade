import { describe, expect, it } from "vitest";
import { Deferred, Effect, Fiber, Stream } from "effect";
import {
  ComponentError,
  type ErrorCategory,
} from "../../../src/core/errors.js";
import {
  makeShutdownController,
  PipelineFatalDrainTimeoutError,
  PipelineShutdownError,
  run,
} from "../../../src/core/pipeline.js";
import { createMessage, type Message } from "../../../src/core/types.js";

class CategorizedTestError extends ComponentError {
  readonly _tag = "CategorizedTestError";
  constructor(
    message: string,
    readonly category: ErrorCategory,
  ) {
    super(message);
  }
}

const messages = (...contents: unknown[]): Message[] =>
  contents.map((content) => createMessage(content));

describe("pipeline error categories", () => {
  it("halts intake after a fatal processor error (concurrency 1)", async () => {
    const delivered: unknown[] = [];
    const inputMessages = messages(0, 1, 2);

    const result = await Effect.runPromise(
      run({
        name: "fatal-processor-halt",
        input: {
          name: "three",
          stream: Stream.fromIterable(inputMessages),
        },
        processors: [
          {
            name: "fatal-on-first",
            process: (msg) => {
              if (msg.content === 0) {
                return Effect.fail(
                  new CategorizedTestError("processor poison", "fatal"),
                );
              }
              return Effect.succeed(msg);
            },
          },
        ],
        output: {
          name: "capture",
          send: (msg) =>
            Effect.sync(() => {
              delivered.push(msg.content);
            }),
        },
        backpressure: { maxConcurrentMessages: 1 },
      }),
    );

    expect(result.success).toBe(false);
    expect(result.shutdown).toBeUndefined();
    expect(delivered).toEqual([]);
    expect(result.stats.failed).toBeGreaterThanOrEqual(1);
    expect(result.stats.processed).toBe(0);
    expect(
      result.errors?.some(
        (error) =>
          error instanceof CategorizedTestError &&
          error.message === "processor poison",
      ),
    ).toBe(true);
  });

  it("halts intake after a fatal output error before later deliveries", async () => {
    const delivered: unknown[] = [];
    const inputMessages = messages(0, 1, 2);

    const result = await Effect.runPromise(
      run({
        name: "fatal-output-halt",
        input: {
          name: "three",
          stream: Stream.fromIterable(inputMessages),
        },
        processors: [],
        output: {
          name: "fatal-on-first",
          send: (msg) => {
            if (msg.content === 0) {
              return Effect.fail(
                new CategorizedTestError("output poison", "fatal"),
              );
            }
            return Effect.sync(() => {
              delivered.push(msg.content);
            });
          },
        },
        backpressure: { maxConcurrentMessages: 1 },
      }),
    );

    expect(result.success).toBe(false);
    expect(result.shutdown).toBeUndefined();
    expect(delivered).toEqual([]);
    expect(result.stats.processed).toBe(0);
    expect(result.stats.failed).toBeGreaterThanOrEqual(1);
    expect(
      result.errors?.some(
        (error) =>
          error instanceof CategorizedTestError &&
          error.message === "output poison",
      ),
    ).toBe(true);
  });

  it("continues intake after a logical processor failure", async () => {
    const delivered: unknown[] = [];
    const inputMessages = messages(0, 1, 2);

    const result = await Effect.runPromise(
      run({
        name: "logical-continues",
        input: {
          name: "three",
          stream: Stream.fromIterable(inputMessages),
        },
        processors: [
          {
            name: "logical-on-first",
            process: (msg) => {
              if (msg.content === 0) {
                return Effect.fail(
                  new CategorizedTestError("bad payload", "logical"),
                );
              }
              return Effect.succeed(msg);
            },
          },
        ],
        output: {
          name: "capture",
          send: (msg) =>
            Effect.sync(() => {
              delivered.push(msg.content);
            }),
        },
        backpressure: { maxConcurrentMessages: 1 },
      }),
    );

    expect(result.success).toBe(false);
    expect(result.shutdown).toBeUndefined();
    expect(delivered).toEqual([1, 2]);
    expect(result.stats.processed).toBe(2);
    expect(result.stats.failed).toBe(1);
  });

  it("drains a finish-current pull already in flight after fatal", async () => {
    const delivered: unknown[] = [];
    const events: string[] = [];

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fatalSendStarted = yield* Deferred.make<void>();
        const releaseFatalSend = yield* Deferred.make<void>();
        const secondPullStarted = yield* Deferred.make<void>();
        const releaseSecondPull = yield* Deferred.make<void>();

        const first = createMessage("fatal");
        const second = createMessage("kept");

        const stream = Stream.concat(
          Stream.make(first),
          Stream.fromEffect(
            Effect.gen(function* () {
              events.push("second-pull-start");
              yield* Deferred.succeed(secondPullStarted, undefined);
              yield* Deferred.await(releaseSecondPull);
              events.push("second-pull-emit");
              return second;
            }),
          ),
        );

        const fiber = yield* Effect.fork(
          run(
            {
              name: "finish-current-after-fatal",
              input: {
                name: "destructive",
                shutdownMode: "finish-current",
                stream,
              },
              processors: [],
              output: {
                name: "capture",
                send: (msg) => {
                  if (msg.content === "fatal") {
                    return Effect.gen(function* () {
                      events.push("fatal-send-start");
                      yield* Deferred.succeed(fatalSendStarted, undefined);
                      yield* Deferred.await(releaseFatalSend);
                      return yield* Effect.fail(
                        new CategorizedTestError("poison", "fatal"),
                      );
                    });
                  }
                  return Effect.sync(() => {
                    events.push(`deliver:${String(msg.content)}`);
                    delivered.push(msg.content);
                  });
                },
              },
              backpressure: { maxConcurrentMessages: 1 },
            },
            { shutdownTimeoutMs: 2_000 },
          ),
        );

        yield* Deferred.await(fatalSendStarted);
        yield* Deferred.await(secondPullStarted);
        // Fatal while the next destructive pull is already in progress.
        yield* Deferred.succeed(releaseFatalSend, undefined);
        // Allow the in-flight finish-current pull to complete and emit.
        yield* Effect.sleep("20 millis");
        yield* Deferred.succeed(releaseSecondPull, undefined);
        return yield* Fiber.join(fiber);
      }),
    );

    expect(result.success).toBe(false);
    expect(result.shutdown).toBeUndefined();
    expect(delivered).toEqual(["kept"]);
    expect(events).toContain("second-pull-emit");
    expect(events).toContain("deliver:kept");
  });

  it("bounds stuck drain after fatal by shutdownTimeoutMs", async () => {
    let inputClosed = 0;
    let outputClosed = 0;
    const fatal = new CategorizedTestError("poison", "fatal");
    const startedAt = Date.now();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const stuckStarted = yield* Deferred.make<void>();
        const fatalStarted = yield* Deferred.make<void>();

        const stuck = createMessage("stuck");
        const poison = createMessage("poison");

        const fiber = yield* Effect.fork(
          run(
            {
              name: "fatal-drain-timeout",
              input: {
                name: "two",
                stream: Stream.make(stuck, poison),
                close: () =>
                  Effect.sync(() => {
                    inputClosed += 1;
                  }),
              },
              processors: [],
              output: {
                name: "mixed",
                send: (msg) => {
                  if (msg.content === "stuck") {
                    return Effect.gen(function* () {
                      yield* Deferred.succeed(stuckStarted, undefined);
                      return yield* Effect.never;
                    });
                  }
                  return Effect.gen(function* () {
                    yield* Deferred.await(stuckStarted);
                    yield* Deferred.succeed(fatalStarted, undefined);
                    return yield* Effect.fail(fatal);
                  });
                },
                close: () =>
                  Effect.sync(() => {
                    outputClosed += 1;
                  }),
              },
              backpressure: { maxConcurrentMessages: 2 },
              shutdownTimeoutMs: 50,
            },
            { shutdownTimeoutMs: 50 },
          ),
        );

        yield* Deferred.await(fatalStarted);
        return yield* Fiber.join(fiber);
      }),
    );
    const elapsedMs = Date.now() - startedAt;

    expect(result.success).toBe(false);
    expect(result.shutdown).toBeUndefined();
    expect(elapsedMs).toBeLessThan(1_000);
    expect(
      result.errors?.some(
        (error) =>
          error instanceof CategorizedTestError &&
          error.category === "fatal" &&
          error.message === fatal.message,
      ),
    ).toBe(true);
    expect(
      result.errors?.some(
        (error) => error instanceof PipelineFatalDrainTimeoutError,
      ),
    ).toBe(true);
    expect(inputClosed).toBeGreaterThanOrEqual(1);
    expect(outputClosed).toBeGreaterThanOrEqual(1);
  });

  it("starts fatal drain timeout before blocked processor DLQ send completes", async () => {
    const originalFatal = new CategorizedTestError("processor poison", "fatal");
    const primarySends: unknown[] = [];
    let dlqAttempts = 0;

    const result = await Effect.runPromise(
      run(
        {
          name: "fatal-before-blocked-dlq",
          input: {
            name: "three",
            stream: Stream.fromIterable(messages(0, 1, 2)),
          },
          processors: [
            {
              name: "fatal-on-first",
              process: (msg) =>
                msg.content === 0
                  ? Effect.fail(originalFatal)
                  : Effect.succeed(msg),
            },
          ],
          output: {
            name: "primary",
            send: (msg) =>
              Effect.sync(() => {
                primarySends.push(msg.content);
              }),
          },
          dlqOutput: {
            name: "blocked-dlq",
            send: () => {
              dlqAttempts += 1;
              return Effect.never;
            },
          },
          backpressure: { maxConcurrentMessages: 1 },
        },
        { shutdownTimeoutMs: 25 },
      ).pipe(Effect.timeout("1 second")),
    );

    expect(result.success).toBe(false);
    expect(result.shutdown).toBeUndefined();
    expect(primarySends).toEqual([]);
    expect(dlqAttempts).toBe(1);
    expect(result.stats.processed).toBe(0);
    expect(result.stats.failed).toBe(1);
    expect(
      result.errors?.some(
        (error) =>
          error instanceof CategorizedTestError &&
          error.message === "processor poison",
      ),
    ).toBe(true);
    expect(
      result.errors?.some(
        (error) => error instanceof PipelineFatalDrainTimeoutError,
      ),
    ).toBe(true);
  });

  it("records fatal DLQ send failure after intake already halted", async () => {
    const originalFatal = new CategorizedTestError("processor poison", "fatal");
    const dlqFatal = new CategorizedTestError("dlq unavailable", "fatal");
    const primarySends: unknown[] = [];
    let dlqAttempts = 0;

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const dlqStarted = yield* Deferred.make<void>();
        const releaseDlq = yield* Deferred.make<void>();

        const fiber = yield* Effect.fork(
          run({
            name: "fatal-dlq-after-halt",
            input: {
              name: "three",
              stream: Stream.fromIterable(messages(0, 1, 2)),
            },
            processors: [
              {
                name: "fatal-on-first",
                process: (msg) =>
                  msg.content === 0
                    ? Effect.fail(originalFatal)
                    : Effect.succeed(msg),
              },
            ],
            output: {
              name: "primary",
              send: (msg) =>
                Effect.sync(() => {
                  primarySends.push(msg.content);
                }),
            },
            dlqOutput: {
              name: "fatal-dlq",
              send: () =>
                Effect.gen(function* () {
                  dlqAttempts += 1;
                  yield* Deferred.succeed(dlqStarted, undefined);
                  yield* Deferred.await(releaseDlq);
                  return yield* Effect.fail(dlqFatal);
                }),
            },
            backpressure: { maxConcurrentMessages: 1 },
          }),
        );

        yield* Deferred.await(dlqStarted);
        yield* Effect.sleep("30 millis");
        expect(primarySends).toEqual([]);
        expect(dlqAttempts).toBe(1);

        yield* Deferred.succeed(releaseDlq, undefined);
        return yield* Fiber.join(fiber);
      }),
    );

    expect(result.success).toBe(false);
    expect(result.shutdown).toBeUndefined();
    expect(primarySends).toEqual([]);
    expect(dlqAttempts).toBe(1);
    expect(result.stats.processed).toBe(0);
    expect(result.stats.failed).toBe(1);
    // Fatal DLQ cause takes precedence for the reported halt cause.
    expect(
      result.errors?.[0] instanceof CategorizedTestError &&
        result.errors[0].message === "dlq unavailable",
    ).toBe(true);
    expect(
      result.errors?.some(
        (error) =>
          error instanceof CategorizedTestError &&
          error.message === "processor poison",
      ),
    ).toBe(true);
    expect(
      result.errors?.some(
        (error) =>
          error instanceof CategorizedTestError &&
          error.message === "dlq unavailable",
      ),
    ).toBe(true);
  });

  it("preserves original fatal when close fails after halt", async () => {
    const fatal = new CategorizedTestError("poison", "fatal");
    const closeError = new Error("close blew up");

    const result = await Effect.runPromise(
      run(
        {
          name: "fatal-then-close-fail",
          input: {
            name: "one",
            stream: Stream.make(createMessage("poison")),
            close: () => Effect.void,
          },
          processors: [],
          output: {
            name: "fatal-then-bad-close",
            send: () => Effect.fail(fatal),
            close: () => Effect.fail(closeError),
          },
          backpressure: { maxConcurrentMessages: 1 },
        },
        { shutdownTimeoutMs: 1_000 },
      ),
    );

    expect(result.success).toBe(false);
    expect(result.shutdown).toBeUndefined();
    expect(
      result.errors?.some(
        (error) =>
          error instanceof CategorizedTestError &&
          error.category === "fatal" &&
          error.message === fatal.message,
      ),
    ).toBe(true);
    expect(result.errors?.some((error) => error === closeError)).toBe(true);
  });

  it("preserves fatal cause when external force wins the drain race", async () => {
    const fatal = new CategorizedTestError("poison", "fatal");

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const stuckStarted = yield* Deferred.make<void>();
        const fatalSendStarted = yield* Deferred.make<void>();
        const shutdown = yield* makeShutdownController();

        const fiber = yield* Effect.fork(
          run(
            {
              name: "fatal-external-force-race",
              input: {
                name: "two",
                stream: Stream.make(
                  createMessage("stuck"),
                  createMessage("poison"),
                ),
              },
              processors: [],
              output: {
                name: "mixed",
                send: (message) =>
                  message.content === "stuck"
                    ? Deferred.succeed(stuckStarted, undefined).pipe(
                        Effect.zipRight(Effect.never),
                      )
                    : Deferred.await(stuckStarted).pipe(
                        Effect.zipRight(
                          Deferred.succeed(fatalSendStarted, undefined),
                        ),
                        Effect.zipRight(Effect.fail(fatal)),
                      ),
              },
              backpressure: { maxConcurrentMessages: 2 },
            },
            { shutdown, shutdownTimeoutMs: 1_000 },
          ),
        );

        yield* Deferred.await(fatalSendStarted);
        // Let processMessage classify and record the failure, then make the
        // external force path win before the fatal drain timeout.
        yield* Effect.sleep("20 millis");
        yield* shutdown.requestForce;
        return yield* Fiber.join(fiber);
      }),
    );

    expect(result.success).toBe(false);
    expect(result.shutdown).toBe("forced");
    expect(
      result.errors?.some(
        (error) =>
          error instanceof CategorizedTestError &&
          error.category === "fatal" &&
          error.message === fatal.message,
      ),
    ).toBe(true);
    expect(
      result.errors?.some(
        (error) =>
          error instanceof PipelineShutdownError && error.shutdown === "forced",
      ),
    ).toBe(true);
  });
});
