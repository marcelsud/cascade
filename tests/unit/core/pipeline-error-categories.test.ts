import { describe, expect, it } from "vitest";
import { Chunk, Deferred, Effect, Fiber, Stream } from "effect";
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
import {
  MAX_ADDITIONAL_FATAL_SAMPLES,
  MAX_RETAINED_HISTORICAL_ERRORS,
  collectHistoricalError,
  collectTerminalError,
  createErrorCollector,
  strongFatalIdentityCount,
  strongHistoricalIdentityCount,
} from "../../../src/core/error-collector.js";
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

  it("bounds retained historical failures while keeping exact failed count", async () => {
    const inputMessages = Array.from({ length: 1_000 }, (_, i) =>
      createMessage(i),
    );

    const result = await Effect.runPromise(
      run({
        name: "bounded-historical-failures",
        input: {
          name: "thousand",
          stream: Stream.fromIterable(inputMessages),
        },
        processors: [
          {
            name: "always-logical-fail",
            process: (msg) =>
              Effect.fail(new CategorizedTestError(`bad-${msg.id}`, "logical")),
          },
        ],
        output: {
          name: "unused",
          send: () => Effect.void,
        },
        backpressure: { maxConcurrentMessages: 1 },
      }),
    );

    expect(result.success).toBe(false);
    expect(result.stats.failed).toBe(1_000);
    expect(result.stats.processed).toBe(0);
    // Historical sample is capped; exact failure count lives on stats.failed.
    expect(result.errors?.length).toBeLessThanOrEqual(100);
    expect(result.errorsOmitted).toBe(900);
    // First-error order preserved for the retained prefix.
    expect(
      result.errors?.[0] instanceof CategorizedTestError &&
        result.errors[0].message === `bad-${inputMessages[0]!.id}`,
    ).toBe(true);
    expect(
      result.errors?.[99] instanceof CategorizedTestError &&
        result.errors[99].message === `bad-${inputMessages[99]!.id}`,
    ).toBe(true);
  });

  it("keeps late fatal cause first and close diagnostic after history cap", async () => {
    const closeError = new Error("close-sentinel");
    const inputMessages = Array.from({ length: 1_001 }, (_, i) =>
      createMessage(i),
    );

    const result = await Effect.runPromise(
      run({
        name: "fatal-after-history-cap",
        input: {
          name: "thousand-then-fatal",
          stream: Stream.fromIterable(inputMessages),
          close: () => Effect.void,
        },
        processors: [
          {
            name: "logical-then-fatal",
            process: (msg) => {
              if (msg.content === 1_000) {
                return Effect.fail(
                  new CategorizedTestError("late-fatal", "fatal"),
                );
              }
              return Effect.fail(
                new CategorizedTestError(`bad-${msg.id}`, "logical"),
              );
            },
          },
        ],
        output: {
          name: "close-fails",
          send: () => Effect.void,
          close: () => Effect.fail(closeError),
        },
        backpressure: { maxConcurrentMessages: 1 },
      }),
    );

    expect(result.success).toBe(false);
    expect(result.shutdown).toBeUndefined();
    // 1000 logical + 1 fatal message failures.
    expect(result.stats.failed).toBe(1_001);
    // Historical sample stays bounded; terminal close is extra and uncapped.
    const errors = result.errors ?? [];
    const historical = errors.filter((error) => error !== closeError);
    // At most 100 historical samples + fatal (if not already in sample) + close.
    expect(historical.length).toBeLessThanOrEqual(101);
    expect(errors.length).toBeLessThanOrEqual(102);
    expect(result.errorsOmitted).toBe(900);

    // Fatal cause is first exactly once (AC-4).
    const fatalMatches = errors.filter(
      (error) =>
        error instanceof CategorizedTestError && error.message === "late-fatal",
    );
    expect(fatalMatches).toHaveLength(1);
    expect(errors[0]).toBe(fatalMatches[0]);

    // Close diagnostic remains observable and is not subject to the cap.
    expect(errors.some((error) => error === closeError)).toBe(true);
  });

  it("does not strongly retain over-cap historical error identities", () => {
    const collector = createErrorCollector();
    const retained: Error[] = [];
    const dropped: Error[] = [];

    for (let i = 0; i < MAX_RETAINED_HISTORICAL_ERRORS; i++) {
      const error = new Error(`retained-${i}`);
      retained.push(error);
      collectHistoricalError(collector, error);
    }
    for (let i = 0; i < 250; i++) {
      const error = new Error(`dropped-${i}`);
      dropped.push(error);
      collectHistoricalError(collector, error);
    }

    // Public sample is capped; omitted count tracks unique drops.
    expect(collector.retained).toHaveLength(MAX_RETAINED_HISTORICAL_ERRORS);
    expect(collector.omitted).toBe(250);
    // Strong identity state must stay bounded to the retained sample.
    // Dropped object identities live only in WeakSet (non-owning).
    expect(strongHistoricalIdentityCount(collector)).toBe(
      MAX_RETAINED_HISTORICAL_ERRORS,
    );

    // Prove over-cap objects are not pinned by any strong collector field.
    const weakDropped = dropped.map((error) => new WeakRef(error));
    dropped.length = 0;
    // Keep retained alive so the collector's legitimate strong set stays valid.
    expect(retained).toHaveLength(MAX_RETAINED_HISTORICAL_ERRORS);

    // Best-effort GC when exposed; structural bound above is the hard assert.
    if ("gc" in globalThis && typeof globalThis.gc === "function") {
      globalThis.gc();
      const stillPinned = weakDropped.filter(
        (ref) => ref.deref() !== undefined,
      );
      expect(stillPinned.length).toBe(0);
    }
  });

  it("preserves over-cap processor fatal after later fatal DLQ replace", async () => {
    const originalFatal = new CategorizedTestError(
      "processor poison after cap",
      "fatal",
    );
    const dlqFatal = new CategorizedTestError("dlq unavailable", "fatal");
    const inputMessages = Array.from({ length: 101 }, (_, i) =>
      createMessage(i),
    );

    const result = await Effect.runPromise(
      run({
        name: "fatal-dlq-after-history-cap",
        input: {
          name: "hundred-logical-then-fatal",
          stream: Stream.fromIterable(inputMessages),
        },
        processors: [
          {
            name: "logical-then-fatal",
            process: (msg) => {
              if (msg.content === 100) {
                return Effect.fail(originalFatal);
              }
              return Effect.fail(
                new CategorizedTestError(`bad-${msg.id}`, "logical"),
              );
            },
          },
        ],
        output: {
          name: "primary",
          send: () => Effect.void,
        },
        dlqOutput: {
          name: "fatal-dlq",
          send: (msg) =>
            // Only the over-cap processor-fatal path should hit a fatal DLQ.
            // Earlier logical failures must succeed so the history cap fills.
            msg.metadata?.dlqReason === originalFatal.message
              ? Effect.fail(dlqFatal)
              : Effect.void,
        },
        backpressure: { maxConcurrentMessages: 1 },
      }),
    );

    expect(result.success).toBe(false);
    expect(result.shutdown).toBeUndefined();
    // 100 logical + 1 fatal message; DLQ failure is recorded but does not
    // inflate stats.failed (same accounting as the non-cap fatal-DLQ test).
    expect(result.stats.failed).toBe(101);
    // No nonfatal diagnostics were dropped — only the over-cap fatals sit outside the sample.
    expect(result.errorsOmitted ?? 0).toBe(0);

    const errors = result.errors ?? [];
    // Current (replaced) cause first. withSpan may clone error objects, so
    // match on message rather than outer reference identity.
    expect(
      errors[0] instanceof CategorizedTestError &&
        errors[0].message === "dlq unavailable",
    ).toBe(true);
    // Displaced over-cap processor fatal remains exactly once.
    const originalMatches = errors.filter(
      (error) =>
        error instanceof CategorizedTestError &&
        error.message === "processor poison after cap",
    );
    expect(originalMatches).toHaveLength(1);
    expect(
      errors.some(
        (error) =>
          error instanceof CategorizedTestError &&
          error.message === "dlq unavailable",
      ),
    ).toBe(true);
  });

  it("keeps reused close sentinel after it was omitted post-cap", () => {
    // Unit-level: withSpan clones processor failures, so end-to-end identity
    // cannot observe the old all-history `seen` rejection. Exercise the
    // collector contract directly — terminal must not consult dropped ids.
    const collector = createErrorCollector();
    for (let i = 0; i < MAX_RETAINED_HISTORICAL_ERRORS; i++) {
      collectHistoricalError(collector, new Error(`retained-${i}`));
    }
    const sharedSentinel = new Error("shared-omitted-then-close");
    collectHistoricalError(collector, sharedSentinel);
    expect(collector.omitted).toBe(1);
    expect(collector.retained.includes(sharedSentinel)).toBe(false);

    collectTerminalError(collector, sharedSentinel);
    expect(collector.terminal).toContain(sharedSentinel);
    expect(collector.terminal.filter((e) => e === sharedSentinel)).toHaveLength(
      1,
    );
  });

  it("does not strongly retain over-cap distinct primitive failures", async () => {
    // End-to-end: 1_000 distinct string failures must not grow strong collector
    // identity state past the retained sample (AC-3). Dropped primitives are
    // counted via errorsOmitted without storing their values.
    const inputMessages = Array.from({ length: 1_000 }, (_, i) =>
      createMessage(i),
    );

    const result = await Effect.runPromise(
      run({
        name: "primitive-string-cap",
        input: {
          name: "thousand-strings",
          stream: Stream.fromIterable(inputMessages),
        },
        processors: [
          {
            name: "fail-string",
            process: (msg) => Effect.fail(`bad-string-${msg.content}`),
          },
        ],
        output: {
          name: "unused",
          send: () => Effect.void,
        },
        backpressure: { maxConcurrentMessages: 1 },
      }),
    );

    expect(result.success).toBe(false);
    expect(result.stats.failed).toBe(1_000);
    expect(result.errors?.length).toBeLessThanOrEqual(
      MAX_RETAINED_HISTORICAL_ERRORS,
    );
    // Each over-cap primitive observation is omitted without value retention.
    expect(result.errorsOmitted).toBe(900);

    // Structural proof: strong historical identity stays capped even when the
    // failure values are primitives (no WeakSet path).
    const collector = createErrorCollector();
    for (let i = 0; i < MAX_RETAINED_HISTORICAL_ERRORS + 250; i++) {
      collectHistoricalError(collector, `primitive-${i}`);
    }
    expect(collector.retained).toHaveLength(MAX_RETAINED_HISTORICAL_ERRORS);
    expect(collector.omitted).toBe(250);
    expect(strongHistoricalIdentityCount(collector)).toBe(
      MAX_RETAINED_HISTORICAL_ERRORS,
    );
  });

  it("bounds many distinct fatal failures under finish-current drain", async () => {
    // finish-current drains an already-emitted chunk after the first halt, so
    // many fatal processor failures can still reach the collector. Fatal state
    // must stay fixed-slot + small sample, not O(F).
    const inputMessages = Array.from({ length: 1_000 }, (_, i) =>
      createMessage(i),
    );

    const result = await Effect.runPromise(
      run({
        name: "many-fatal-finish-current",
        input: {
          name: "thousand-fatal",
          shutdownMode: "finish-current",
          // Single chunk so haltWhenDeferred still drains every element after
          // the first fatal (mirrors the reviewer's finish-current probe).
          stream: Stream.fromChunk(Chunk.fromIterable(inputMessages)),
        },
        processors: [
          {
            name: "always-fatal",
            process: (msg) =>
              Effect.fail(
                new CategorizedTestError(`fatal-${msg.content}`, "fatal"),
              ),
          },
        ],
        output: {
          name: "unused",
          send: () => Effect.void,
        },
        backpressure: { maxConcurrentMessages: 1 },
      }),
    );

    expect(result.success).toBe(false);
    expect(result.stats.failed).toBe(1_000);
    const errors = result.errors ?? [];
    // Historical sample (≤100) + first fatal + ≤8 extra fatals. Current fatal
    // may already be in that set. Hard upper bound stays far below 1_000.
    const maxFatalSamples = 1 + MAX_ADDITIONAL_FATAL_SAMPLES;
    expect(errors.length).toBeLessThanOrEqual(
      MAX_RETAINED_HISTORICAL_ERRORS + maxFatalSamples,
    );
    // Fatals past first+extra that miss the historical sample are omitted.
    // 1000 fatals: first 100 enter retained (+ first/extra slots among them);
    // remaining 900 are overflow past fatal sample once first+extra are full.
    expect(result.errorsOmitted).toBe(900);

    // Collector-level: fatal strong identity never exceeds fixed capacity.
    const collector = createErrorCollector();
    for (let i = 0; i < 500; i++) {
      collectHistoricalError(
        collector,
        new CategorizedTestError(`unit-fatal-${i}`, "fatal"),
      );
    }
    expect(strongFatalIdentityCount(collector)).toBeLessThanOrEqual(
      maxFatalSamples,
    );
    expect(strongHistoricalIdentityCount(collector)).toBe(
      MAX_RETAINED_HISTORICAL_ERRORS,
    );
  });

  it("retains undefined processor and fatal-close diagnostics", async () => {
    // undefined is a valid Effect failure value and must appear in samples.
    const processorResult = await Effect.runPromise(
      run({
        name: "undefined-processor-fail",
        input: {
          name: "one",
          stream: Stream.make(createMessage("x")),
        },
        processors: [
          {
            name: "fail-undefined",
            process: () => Effect.fail(undefined),
          },
        ],
        output: {
          name: "unused",
          send: () => Effect.void,
        },
        backpressure: { maxConcurrentMessages: 1 },
      }),
    );

    expect(processorResult.success).toBe(false);
    expect(processorResult.stats.failed).toBe(1);
    expect(processorResult.errors).toBeDefined();
    expect(processorResult.errors?.some((error) => error === undefined)).toBe(
      true,
    );

    const fatal = new CategorizedTestError("poison", "fatal");
    const closeResult = await Effect.runPromise(
      run(
        {
          name: "fatal-then-undefined-close",
          input: {
            name: "one",
            stream: Stream.make(createMessage("poison")),
            close: () => Effect.void,
          },
          processors: [],
          output: {
            name: "fatal-then-undefined-close",
            send: () => Effect.fail(fatal),
            close: () => Effect.fail(undefined),
          },
          backpressure: { maxConcurrentMessages: 1 },
        },
        { shutdownTimeoutMs: 1_000 },
      ),
    );

    expect(closeResult.success).toBe(false);
    expect(
      closeResult.errors?.some(
        (error) =>
          error instanceof CategorizedTestError &&
          error.message === "poison",
      ),
    ).toBe(true);
    expect(closeResult.errors?.some((error) => error === undefined)).toBe(true);
  });

  it("includes retained historical samples on non-fatal close failure", async () => {
    // failedResult must assemble primary + retained + terminal, not primary alone.
    const closeError = new Error("close-after-history");
    const inputMessages = Array.from({ length: 150 }, (_, i) =>
      createMessage(i),
    );

    const result = await Effect.runPromise(
      run({
        name: "close-after-150-logical",
        input: {
          name: "hundred-fifty",
          stream: Stream.fromIterable(inputMessages),
          close: () => Effect.void,
        },
        processors: [
          {
            name: "always-logical",
            process: (msg) =>
              Effect.fail(
                new CategorizedTestError(`bad-${msg.content}`, "logical"),
              ),
          },
        ],
        output: {
          name: "close-fails",
          send: () => Effect.void,
          close: () => Effect.fail(closeError),
        },
        backpressure: { maxConcurrentMessages: 1 },
      }),
    );

    expect(result.success).toBe(false);
    expect(result.stats.failed).toBe(150);
    expect(result.errorsOmitted).toBe(50);
    const errors = result.errors ?? [];
    // Primary close error first.
    expect(errors[0]).toBe(closeError);
    // Retained historical samples are present (not discarded by failedResult).
    const historical = errors.filter((error) => error !== closeError);
    expect(historical.length).toBe(MAX_RETAINED_HISTORICAL_ERRORS);
    expect(
      historical.every(
        (error) =>
          error instanceof CategorizedTestError && error.category === "logical",
      ),
    ).toBe(true);
    // Total = primary + retained (close not already in retained).
    expect(errors.length).toBe(1 + MAX_RETAINED_HISTORICAL_ERRORS);
  });

  it("does not export error collector test utils from the package root", async () => {
    // Export-surface check: static namespace imports of known modules (not a
    // runtime-selected specifier) so the root/pipeline barrels stay free of
    // the internal collector seam.
    const root = await import("../../../src/index.js");
    const pipeline = await import("../../../src/core/pipeline.js");
    expect(
      Object.prototype.hasOwnProperty.call(root, "__errorCollectorTestUtils"),
    ).toBe(false);
    expect(
      Object.prototype.hasOwnProperty.call(root, "createErrorCollector"),
    ).toBe(false);
    expect(
      Object.prototype.hasOwnProperty.call(
        pipeline,
        "__errorCollectorTestUtils",
      ),
    ).toBe(false);
  });
});
