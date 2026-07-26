/**
 * Pipeline orchestration using Effect.js
 */
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FiberSet,
  Ref,
  Stream,
  pipe,
} from "effect";
import type {
  Message,
  Pipeline,
  PipelineResult,
  PipelineStats,
} from "./types.js";
import { runProcessorChain } from "./processor-chain.js";
import { isFatalError } from "./errors.js";
import { createDLQMessage } from "./dlq.js";

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;
/** Max historical nonfatal failure objects retained for diagnostics. */
const MAX_RETAINED_HISTORICAL_ERRORS = 100;

const isObjectIdentity = (error: unknown): error is object =>
  (typeof error === "object" && error !== null) || typeof error === "function";

/**
 * Bounded failure sampler owned by a single pipeline run.
 * Historical diagnostics are capped; terminal close/drain diagnostics and
 * distinct fatal causes are not. Strong identity state for the historical
 * sample stays capped — dropped object identities are tracked in a WeakSet
 * so they remain dedupable without pinning heap graphs. Non-object dropped
 * identities (strings/numbers/symbols/booleans) live in a small primitive set:
 * they have no object graph to retain.
 */
interface ErrorCollector {
  retained: unknown[];
  /** Strong identities for the retained sample only (≤ MAX). */
  retainedSeen: Set<unknown>;
  /** Non-owning identity tracking for dropped historical object errors. */
  droppedObjects: WeakSet<object>;
  /** Dropped non-object identities (no object graph; safe to hold by value). */
  droppedPrimitives: Set<unknown>;
  /**
   * Distinct fatal causes observed this run (uncapped). Includes over-cap and
   * displaced causes so a later fatal DLQ replace cannot erase earlier fatals.
   */
  fatals: unknown[];
  fatalSeen: Set<unknown>;
  /** Unique historical diagnostics observed (retained + omitted). */
  total: number;
  /** Unique historical diagnostics dropped after the retention cap. */
  omitted: number;
  /** Close/drain diagnostics — not subject to the historical retention cap. */
  terminal: unknown[];
}

const createErrorCollector = (): ErrorCollector => ({
  retained: [],
  retainedSeen: new Set<unknown>(),
  droppedObjects: new WeakSet<object>(),
  droppedPrimitives: new Set<unknown>(),
  fatals: [],
  fatalSeen: new Set<unknown>(),
  total: 0,
  omitted: 0,
  terminal: [],
});

const hasHistoricalIdentity = (
  collector: ErrorCollector,
  error: unknown,
): boolean => {
  if (collector.retainedSeen.has(error)) {
    return true;
  }
  if (isObjectIdentity(error)) {
    return collector.droppedObjects.has(error);
  }
  return collector.droppedPrimitives.has(error);
};

const trackDroppedIdentity = (
  collector: ErrorCollector,
  error: unknown,
): void => {
  if (isObjectIdentity(error)) {
    collector.droppedObjects.add(error);
  } else {
    collector.droppedPrimitives.add(error);
  }
};

const noteFatalCause = (collector: ErrorCollector, error: unknown): void => {
  if (error === undefined || collector.fatalSeen.has(error)) {
    return;
  }
  collector.fatalSeen.add(error);
  collector.fatals.push(error);
};

/** Mutate collector in place: O(1) identity dedup + capped strong retention. */
const collectHistoricalError = (
  collector: ErrorCollector,
  error: unknown,
): ErrorCollector => {
  if (error === undefined || hasHistoricalIdentity(collector, error)) {
    return collector;
  }
  collector.total += 1;
  if (isFatalError(error)) {
    // Fatals are always recorded in uncapped fatal state (AC-4), even when the
    // historical sample is full and the object is not strongly retained there.
    noteFatalCause(collector, error);
  }
  if (collector.retained.length < MAX_RETAINED_HISTORICAL_ERRORS) {
    collector.retained.push(error);
    collector.retainedSeen.add(error);
  } else if (!isFatalError(error)) {
    // Over-cap historical nonfatal samples are dropped and counted. Identity
    // stays dedupable via non-owning tracking so memory stays bounded.
    collector.omitted += 1;
    trackDroppedIdentity(collector, error);
  } else {
    // Over-cap fatal: not omitted (surfaced via fatals/fatalCauseRef), and not
    // strongly retained in the historical sample.
    trackDroppedIdentity(collector, error);
  }
  return collector;
};

/**
 * Always retain terminal close/drain diagnostics (uncapped).
 * Dedup only against terminal + actually retained samples — never against
 * dropped historical identities, so a close error reused after being omitted
 * from the sample remains observable.
 */
const collectTerminalError = (
  collector: ErrorCollector,
  error: unknown,
): ErrorCollector => {
  if (error === undefined) {
    return collector;
  }
  // Terminal list stays tiny (close/drain); linear scan is fine and bounded.
  if (collector.terminal.includes(error) || collector.retainedSeen.has(error)) {
    return collector;
  }
  collector.terminal.push(error);
  return collector;
};

/**
 * Test seam for retention/dedup regressions. Not part of the public API.
 * @internal
 */
export const __errorCollectorTestUtils = {
  MAX_RETAINED_HISTORICAL_ERRORS,
  createErrorCollector,
  collectHistoricalError,
  collectTerminalError,
  hasHistoricalIdentity,
  strongHistoricalIdentityCount: (collector: ErrorCollector): number =>
    collector.retainedSeen.size + collector.droppedPrimitives.size,
};

/** Pipeline execution errors. */
export class PipelineError {
  readonly _tag = "PipelineError";
  constructor(
    readonly message: string,
    readonly cause?: unknown,
  ) {}
}

export class PipelineShutdownError extends PipelineError {
  readonly shutdown: "timed-out" | "forced";

  constructor(shutdown: "timed-out" | "forced") {
    super(
      shutdown === "forced"
        ? "Pipeline shutdown was forced"
        : "Pipeline graceful shutdown timed out",
    );
    this.shutdown = shutdown;
  }
}

/**
 * Internal signal: a processor/output failure classified as fatal.
 * Halts further intake without using the external shutdown controller.
 */
export class PipelineFatalHaltError extends PipelineError {
  constructor(readonly cause: unknown) {
    super(
      cause instanceof Error
        ? `Pipeline halted on fatal error: ${cause.message}`
        : `Pipeline halted on fatal error: ${String(cause)}`,
      cause,
    );
  }
}

/** Drain/close exceeded shutdownTimeoutMs after a fatal halt. */
export class PipelineFatalDrainTimeoutError extends PipelineError {
  constructor() {
    super("Pipeline drain timed out after fatal error");
  }
}

/** Signals used by callers such as the CLI to control pipeline shutdown. */
export interface PipelineShutdownController {
  readonly stop: Deferred.Deferred<void>;
  readonly force: Deferred.Deferred<void>;
  readonly request: Effect.Effect<void>;
  readonly requestForce: Effect.Effect<void>;
}

export const makeShutdownController =
  (): Effect.Effect<PipelineShutdownController> =>
    Effect.gen(function* () {
      const stop = yield* Deferred.make<void>();
      const force = yield* Deferred.make<void>();
      return {
        stop,
        force,
        request: Deferred.succeed(stop, undefined).pipe(Effect.asVoid),
        requestForce: Deferred.succeed(force, undefined).pipe(
          Effect.zipRight(Deferred.succeed(stop, undefined)),
          Effect.asVoid,
        ),
      };
    });

export interface RunOptions {
  readonly shutdown?: PipelineShutdownController;
  readonly shutdownTimeoutMs?: number;
}

const closePipeline = <E, R>(pipeline: Pipeline<E, R>, timeoutMs: number) =>
  Effect.gen(function* () {
    if (pipeline.input.close) yield* pipeline.input.close();
    if (pipeline.output.close) yield* pipeline.output.close();
  }).pipe(
    Effect.timeoutFail({
      duration: `${timeoutMs} millis`,
      onTimeout: () => new PipelineShutdownError("timed-out"),
    }),
  );

/**
 * Run a pipeline. A graceful shutdown interrupts intake only; tracked message
 * workers continue through processing, output delivery, and acknowledgement.
 */
export const run = <E, R>(
  pipeline: Pipeline<E, R>,
  options: RunOptions = {},
): Effect.Effect<PipelineResult, never, R> =>
  Effect.gen(function* () {
    const shutdown = options.shutdown ?? (yield* makeShutdownController());
    const shutdownTimeoutMs =
      options.shutdownTimeoutMs ??
      pipeline.shutdownTimeoutMs ??
      DEFAULT_SHUTDOWN_TIMEOUT_MS;
    const finishCurrentPull = pipeline.input.shutdownMode === "finish-current";

    const statsRef = yield* Ref.make({
      processed: 0,
      failed: 0,
      startTime: Date.now(),
    });
    const errorsRef = yield* Ref.make<ErrorCollector>(createErrorCollector());
    // Internal halt channel — distinct from external graceful shutdown.
    // Signal (void) stops intake immediately; cause may be updated later
    // (e.g. fatal DLQ send replaces the reported original fatal).
    const fatalHalt = yield* Deferred.make<void>();
    const fatalCauseRef = yield* Ref.make<unknown | undefined>(undefined);
    // Ensure input/output close runs at most once across fatal/normal paths.
    const closedRef = yield* Ref.make(false);

    const snapshotMetrics = () => {
      const input = pipeline.input.getMetrics?.();
      const output = pipeline.output.getMetrics?.();
      const dlq = pipeline.output.getDLQMetrics?.();
      return input || output || dlq ? { input, output, dlq } : undefined;
    };
    const snapshotStats = (): Effect.Effect<PipelineStats> =>
      Effect.gen(function* () {
        const stats = yield* Ref.get(statsRef);
        const now = Date.now();
        return {
          processed: stats.processed,
          failed: stats.failed,
          duration: now - stats.startTime,
          startTime: stats.startTime,
          endTime: now,
        };
      });
    const failedResult = (
      error: unknown,
      shutdownReason?: "timed-out" | "forced",
    ): Effect.Effect<PipelineResult> =>
      Effect.gen(function* () {
        const stats = yield* snapshotStats();
        const collector = yield* Ref.get(errorsRef);
        return {
          success: false,
          stats,
          errors: [error],
          ...(collector.omitted > 0
            ? { errorsOmitted: collector.omitted }
            : {}),
          shutdown: shutdownReason,
          metrics: snapshotMetrics(),
        };
      });
    /**
     * Build a non-graceful fatal failure from the bounded collector, with the
     * fatal cause first and terminal diagnostics always included. Single
     * O(retained + terminal + additional) pass — no nested scans.
     */
    const fatalFailedResult = (
      additionalErrors: readonly unknown[] = [],
    ): Effect.Effect<PipelineResult> =>
      Effect.gen(function* () {
        const stats = yield* snapshotStats();
        const collector = yield* Ref.get(errorsRef);
        const errors: unknown[] = [];
        const seen = new Set<unknown>();
        const pushUnique = (error: unknown) => {
          if (error === undefined || seen.has(error)) {
            return;
          }
          seen.add(error);
          errors.push(error);
        };

        // Prefer the recorded (possibly replaced) fatal cause first when
        // present, then every earlier distinct fatal exactly once — including
        // over-cap / displaced causes that never entered the retained sample.
        const fatalCause = yield* Ref.get(fatalCauseRef);
        if (fatalCause !== undefined) {
          pushUnique(fatalCause);
        }
        for (const error of collector.fatals) {
          pushUnique(error);
        }
        for (const error of collector.retained) {
          pushUnique(error);
        }
        for (const error of collector.terminal) {
          pushUnique(error);
        }
        for (const error of additionalErrors) {
          pushUnique(error);
        }

        return {
          success: false,
          stats,
          errors: errors.length > 0 ? errors : undefined,
          ...(collector.omitted > 0
            ? { errorsOmitted: collector.omitted }
            : {}),
          metrics: snapshotMetrics(),
        } satisfies PipelineResult;
      });
    const recordError = (error: unknown) =>
      Ref.update(errorsRef, (collector) =>
        collectHistoricalError(collector, error),
      );
    const recordTerminalError = (error: unknown) =>
      Ref.update(errorsRef, (collector) =>
        collectTerminalError(collector, error),
      );
    /** Record/replace fatal cause and stop intake (first signal wins stop). */
    const signalFatalHalt = (
      cause: unknown,
      mode: "first" | "replace" = "first",
    ) =>
      Effect.gen(function* () {
        yield* Ref.update(fatalCauseRef, (current) => {
          if (current === undefined || mode === "replace") {
            return cause;
          }
          return current;
        });
        yield* Deferred.succeed(fatalHalt, undefined).pipe(Effect.asVoid);
      });

    // Close once across normal completion and fatal-timeout interrupt paths.
    // If the fatal watchdog interrupts a close already in progress, leave it
    // unclaimed so the watchdog can retry cleanup after execution stops.
    const ensureClose = Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        if (yield* Ref.get(closedRef)) {
          return;
        }
        const exit = yield* Effect.exit(
          restore(closePipeline(pipeline, shutdownTimeoutMs)),
        );
        if (!Exit.isInterrupted(exit)) {
          yield* Ref.set(closedRef, true);
        }
        return yield* Exit.matchEffect(exit, {
          onSuccess: () => Effect.void,
          onFailure: Effect.failCause,
        });
      }),
    );

    const maxConcurrentMessages =
      pipeline.backpressure?.maxConcurrentMessages ?? 10;
    const maxConcurrentOutputs =
      pipeline.backpressure?.maxConcurrentOutputs ?? 5;

    // Explicit pipeline handle wins; else wrapper-configured raw DLQ.
    const processorDlqOutput =
      pipeline.dlqOutput ?? pipeline.output.getDLQOutput?.();

    const processMessage = (
      msg: Message,
      output: (typeof pipeline)["output"],
      wrapOuterPermit: boolean,
      outputPermits: Effect.Semaphore,
    ) => {
      const recordMessageFailure = (
        error: unknown,
        options: { readonly routeToDlq: boolean },
      ) =>
        Effect.gen(function* () {
          yield* Ref.update(statsRef, (stats) => ({
            ...stats,
            failed: stats.failed + 1,
          }));
          yield* recordError(error);
          yield* Effect.logError(`Message processing failed: ${error}`);

          // Stop intake immediately on original fatal — do not wait for DLQ.
          if (isFatalError(error)) {
            yield* signalFatalHalt(error, "first");
          }

          // Processor-chain failures only. Output failures stay with withDLQ.
          if (options.routeToDlq && processorDlqOutput) {
            yield* Effect.logWarning(
              `Message ${msg.id} failed during processing, sending to DLQ: ${error}`,
            );

            const dlqMessage = createDLQMessage(msg, error, 1);
            yield* processorDlqOutput.send(dlqMessage).pipe(
              Effect.catchAll((dlqError) =>
                Effect.gen(function* () {
                  yield* Effect.logError(
                    `Failed to send message ${msg.id} to DLQ: ${dlqError}`,
                  );
                  // Preserve original failure accounting; also record DLQ failure.
                  yield* recordError(dlqError);
                  // Fatal DLQ failures replace the reported halt cause.
                  if (isFatalError(dlqError)) {
                    yield* signalFatalHalt(dlqError, "replace");
                  }
                }),
              ),
            );
          }
        });

      // Prefer wrapper-local primary permits (withDLQ / withBackpressure) so
      // retry backoff and DLQ routing do not hold a primary output slot.
      // Ordinary unwrapped outputs keep the outer permit guard below.
      // Decide outer wrap from whether the original output exposed a binder
      // (bound copies may omit the optional method without meaning "unbound").
      return pipe(
        runProcessorChain(msg, pipeline.processors),
        Effect.flatMap((messages) =>
          pipe(
            Effect.forEach(
              messages,
              (message) =>
                pipe(
                  wrapOuterPermit
                    ? outputPermits.withPermits(1)(output.send(message))
                    : output.send(message),
                  Effect.tap(() =>
                    Ref.update(statsRef, (stats) => ({
                      ...stats,
                      processed: stats.processed + 1,
                    })),
                  ),
                ),
              { concurrency: maxConcurrentOutputs },
            ),
            // Ack only after processors + primary output succeed.
            Effect.tap(() => (msg.ack ? msg.ack() : Effect.void)),
            Effect.catchAll((error) =>
              recordMessageFailure(error, { routeToDlq: false }),
            ),
          ),
        ),
        Effect.catchAll((error) =>
          recordMessageFailure(error, { routeToDlq: true }),
        ),
        Effect.withSpan("process-message", {
          attributes: { messageId: msg.id },
        }),
      );
    };

    const execution = Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.log(`Starting pipeline: ${pipeline.name}`);
        const workers = yield* FiberSet.make<void, never>();
        const permits = yield* Effect.makeSemaphore(maxConcurrentMessages);
        const outputPermits = yield* Effect.makeSemaphore(maxConcurrentOutputs);
        // Bind once per run. Fallback outer wrap depends on the pre-bind hook,
        // not on whether the returned copy re-exposes bindPrimaryOutputPermits.
        const bindPrimary = pipeline.output.bindPrimaryOutputPermits;
        const output =
          bindPrimary !== undefined
            ? bindPrimary.call(pipeline.output, outputPermits)
            : pipeline.output;
        const wrapOuterPermit = bindPrimary === undefined;
        // Stop intake on external shutdown OR internal fatal halt.
        const intakeStop = yield* Deferred.make<void>();
        yield* Effect.forkScoped(
          Deferred.await(shutdown.stop).pipe(
            Effect.zipRight(Deferred.succeed(intakeStop, undefined)),
            Effect.asVoid,
          ),
        );
        yield* Effect.forkScoped(
          Deferred.await(fatalHalt).pipe(
            Effect.zipRight(Deferred.succeed(intakeStop, undefined)),
            Effect.asVoid,
          ),
        );

        const stoppedInput = finishCurrentPull
          ? pipeline.input.stream.pipe(Stream.haltWhenDeferred(intakeStop))
          : pipeline.input.stream.pipe(
              Stream.interruptWhenDeferred(intakeStop),
            );

        yield* stoppedInput.pipe(
          Stream.runForEach((message) =>
            Effect.gen(function* () {
              // Interruptible inputs may drop post-fatal emissions.
              // finish-current emissions were already removed upstream — drain them.
              if (!finishCurrentPull && (yield* Deferred.isDone(fatalHalt))) {
                return;
              }
              yield* permits.take(1);
              if (!finishCurrentPull && (yield* Deferred.isDone(fatalHalt))) {
                yield* permits.release(1);
                return;
              }
              yield* FiberSet.run(
                workers,
                processMessage(message, output, wrapOuterPermit, outputPermits).pipe(
                  Effect.ensuring(permits.release(1)),
                ),
              );
            }),
          ),
          Effect.catchAll((error) =>
            Effect.gen(function* () {
              yield* Effect.logError(`Pipeline stream error: ${error}`);
              yield* Ref.update(statsRef, (stats) => ({
                ...stats,
                failed: stats.failed + 1,
              }));
              yield* recordError(error);
              if (isFatalError(error)) {
                yield* signalFatalHalt(error, "first");
              }
            }),
          ),
        );

        yield* FiberSet.awaitEmpty(workers);

        const closeResult = yield* Effect.either(ensureClose);
        if (closeResult._tag === "Left") {
          yield* recordTerminalError(closeResult.left);
          if (!(yield* Deferred.isDone(fatalHalt))) {
            // Non-fatal path: preserve prior external close-failure behavior.
            return yield* Effect.fail(closeResult.left);
          }
        }

        const stats = yield* Ref.get(statsRef);
        const collector = yield* Ref.get(errorsRef);
        const fatalDone = yield* Deferred.isDone(fatalHalt);
        const resolvedFatal = fatalDone
          ? yield* Ref.get(fatalCauseRef)
          : undefined;

        const finalStats: PipelineStats = {
          processed: stats.processed,
          failed: stats.failed,
          duration: Date.now() - stats.startTime,
          startTime: stats.startTime,
          endTime: Date.now(),
        };

        if (resolvedFatal !== undefined) {
          yield* Effect.log(
            `Pipeline halted on fatal error: ${finalStats.processed} processed, ${finalStats.failed} failed in ${finalStats.duration}ms`,
          );
          return yield* Effect.fail(new PipelineFatalHaltError(resolvedFatal));
        }

        yield* Effect.log(
          `Pipeline completed: ${finalStats.processed} processed, ${finalStats.failed} failed in ${finalStats.duration}ms`,
        );
        const sample =
          collector.retained.length > 0 || collector.terminal.length > 0
            ? [...collector.retained, ...collector.terminal]
            : undefined;
        return {
          success: finalStats.failed === 0,
          stats: finalStats,
          errors: sample,
          ...(collector.omitted > 0
            ? { errorsOmitted: collector.omitted }
            : {}),
          metrics: snapshotMetrics(),
        } satisfies PipelineResult;
      }),
    );

    const executionFiber = yield* Effect.forkDaemon(execution);
    const awaitExecution = Fiber.await(executionFiber).pipe(
      Effect.flatMap((exit) =>
        Exit.matchEffect(exit, {
          onSuccess: Effect.succeed,
          // A controlled timeout/force path interrupts execution itself. Do
          // not let that interruption win the surrounding completion race.
          onFailure: (cause) =>
            Cause.isInterruptedOnly(cause)
              ? Effect.never
              : Effect.failCause(cause),
        }),
      ),
    );
    const interruptedResult = (
      reason: "timed-out" | "forced",
    ): Effect.Effect<PipelineResult> =>
      Effect.gen(function* () {
        yield* Effect.forkDaemon(Fiber.interrupt(executionFiber));
        return yield* failedResult(new PipelineShutdownError(reason), reason);
      });

    // Tracks whether the race winner already assembled a fatal PipelineResult
    // so we never rebuild/deduplicate the historical sample twice (AC-4).
    let fatalResultAssembled = false;

    const interruptFatalDrain = (): Effect.Effect<PipelineResult, never, R> =>
      Effect.gen(function* () {
        // Interrupt stuck workers / blocked finish-current pulls, then close.
        // Await interruption so FiberSet/scope finalizers settle before close.
        yield* Fiber.interrupt(executionFiber);
        const closeResult = yield* Effect.either(ensureClose);
        const drainTimeout = new PipelineFatalDrainTimeoutError();
        yield* recordTerminalError(drainTimeout);
        if (closeResult._tag === "Left") {
          yield* recordTerminalError(closeResult.left);
        }
        fatalResultAssembled = true;
        return yield* fatalFailedResult();
      });

    const result: PipelineResult = yield* Effect.raceFirst(
      awaitExecution,
      Effect.raceFirst(
        // Bound remaining work after an internal fatal halt.
        Deferred.await(fatalHalt).pipe(
          Effect.flatMap(() =>
            Effect.sleep(`${shutdownTimeoutMs} millis`).pipe(
              Effect.flatMap(() => interruptFatalDrain()),
            ),
          ),
        ),
        Deferred.await(shutdown.stop).pipe(
          Effect.flatMap(() =>
            Effect.raceFirst(
              Effect.raceFirst(
                awaitExecution.pipe(
                  Effect.map((result) => ({
                    ...result,
                    shutdown: "graceful" as const,
                  })),
                ),
                Effect.sleep(`${shutdownTimeoutMs} millis`).pipe(
                  Effect.flatMap(() => interruptedResult("timed-out")),
                ),
              ),
              Deferred.await(shutdown.force).pipe(
                Effect.flatMap(() => interruptedResult("forced")),
              ),
            ),
          ),
        ),
      ),
    ).pipe(
      Effect.catchAll((error: unknown) =>
        Effect.gen(function* () {
          const fatalRequested = yield* Deferred.isDone(fatalHalt);
          if (fatalRequested || error instanceof PipelineFatalHaltError) {
            // Preserve original fatal cause(s); append cleanup failures.
            const additional =
              error instanceof PipelineFatalHaltError ? [] : [error];
            fatalResultAssembled = true;
            return yield* fatalFailedResult(additional);
          }
          return yield* failedResult(
            error,
            error instanceof PipelineShutdownError ? error.shutdown : undefined,
          );
        }),
      ),
    );
    // Only external stop requests count as graceful shutdown.
    const shutdownRequested = yield* Deferred.isDone(shutdown.stop);
    const fatalRequested = yield* Deferred.isDone(fatalHalt);
    if (fatalRequested) {
      // External timeout/force may win after fatal was recorded. Assemble at
      // most once from the fatal channel so shutdown metadata cannot replace
      // the fatal cause, and so historical samples are never rebuilt twice.
      const fatalResult = fatalResultAssembled
        ? result
        : yield* fatalFailedResult(result.errors ?? []);
      return {
        ...fatalResult,
        shutdown: result.shutdown === "graceful" ? undefined : result.shutdown,
      };
    }
    return shutdownRequested && result.shutdown === undefined
      ? { ...result, shutdown: "graceful" as const }
      : result;
  });

/** Create a pipeline from configuration. */
export const create = <E, R>(config: {
  name: string;
  input: Pipeline<E, R>["input"];
  processors: Pipeline<E, R>["processors"];
  output: Pipeline<E, R>["output"];
}): Pipeline<E, R> => config;
