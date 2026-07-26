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
import {
  assembleErrorSample,
  collectHistoricalError,
  collectTerminalError,
  createErrorCollector,
  NO_FATAL_CAUSE,
  noteFatalCause,
} from "./error-collector.js";
import type {
  ErrorCollector,
  FatalCauseSlot,
} from "./error-collector.js";

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

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
    const fatalCauseRef = yield* Ref.make<FatalCauseSlot>(NO_FATAL_CAUSE);
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
        // Primary close/timeout/force error first, then retained sample and
        // terminal diagnostics — same identity pass as fatal assembly.
        const { errors, errorsOmitted } = assembleErrorSample({
          hasPrimary: true,
          primary: error,
          collector,
        });
        return {
          success: false,
          stats,
          errors: errors.length > 0 ? errors : undefined,
          ...(errorsOmitted > 0 ? { errorsOmitted } : {}),
          shutdown: shutdownReason,
          metrics: snapshotMetrics(),
        } satisfies PipelineResult;
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
        const fatalCause = yield* Ref.get(fatalCauseRef);
        const hasCurrentFatal = fatalCause !== NO_FATAL_CAUSE;
        const { errors, errorsOmitted } = assembleErrorSample({
          hasCurrentFatal,
          currentFatal: hasCurrentFatal ? fatalCause : undefined,
          collector,
          additional: additionalErrors,
        });

        return {
          success: false,
          stats,
          errors: errors.length > 0 ? errors : undefined,
          ...(errorsOmitted > 0 ? { errorsOmitted } : {}),
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
        // Keep the live current-cause slot and the collector's bounded fatal
        // sample in lockstep. noteFatalCause is a no-op for duplicates and
        // overflows past the fixed extra-fatal capacity.
        yield* Ref.update(errorsRef, (collector) => {
          noteFatalCause(collector, cause);
          return collector;
        });
        yield* Ref.update(fatalCauseRef, (current) => {
          if (current === NO_FATAL_CAUSE || mode === "replace") {
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
        const fatalCause = yield* Ref.get(fatalCauseRef);
        const hasFatalCause = fatalDone && fatalCause !== NO_FATAL_CAUSE;

        const finalStats: PipelineStats = {
          processed: stats.processed,
          failed: stats.failed,
          duration: Date.now() - stats.startTime,
          startTime: stats.startTime,
          endTime: Date.now(),
        };

        if (hasFatalCause) {
          yield* Effect.log(
            `Pipeline halted on fatal error: ${finalStats.processed} processed, ${finalStats.failed} failed in ${finalStats.duration}ms`,
          );
          return yield* Effect.fail(new PipelineFatalHaltError(fatalCause));
        }

        yield* Effect.log(
          `Pipeline completed: ${finalStats.processed} processed, ${finalStats.failed} failed in ${finalStats.duration}ms`,
        );
        const sample =
          collector.retained.length > 0 || collector.terminal.length > 0
            ? [...collector.retained, ...collector.terminal]
            : undefined;
        const errorsOmitted =
          collector.omitted + collector.fatalOverflowOmitted;
        return {
          success: finalStats.failed === 0,
          stats: finalStats,
          errors: sample,
          ...(errorsOmitted > 0 ? { errorsOmitted } : {}),
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
    ): Effect.Effect<PipelineResult, never, R> =>
      Effect.gen(function* () {
        // Await interruption so FiberSet/scope finalizers settle before close.
        yield* Fiber.interrupt(executionFiber);
        const closeResult = yield* Effect.either(ensureClose);
        if (closeResult._tag === "Left") {
          yield* recordTerminalError(closeResult.left);
        }
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
