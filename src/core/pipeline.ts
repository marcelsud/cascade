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
    const errorsRef = yield* Ref.make<unknown[]>([]);
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
        return {
          success: false,
          stats,
          errors: [error],
          shutdown: shutdownReason,
          metrics: snapshotMetrics(),
        };
      });
    /**
     * Build a non-graceful fatal failure from errors already recorded in
     * `errorsRef`, optionally appending cleanup/drain failures.
     */
    const fatalFailedResult = (
      additionalErrors: readonly unknown[] = [],
    ): Effect.Effect<PipelineResult> =>
      Effect.gen(function* () {
        const stats = yield* snapshotStats();
        const prior = yield* Ref.get(errorsRef);
        const errors: unknown[] = [];
        const pushUnique = (error: unknown) => {
          if (error !== undefined && !errors.includes(error)) {
            errors.push(error);
          }
        };

        // Prefer the recorded fatal cause first when present.
        const fatalCause = yield* Ref.get(fatalCauseRef);
        if (fatalCause !== undefined) {
          pushUnique(fatalCause);
        }
        for (const error of prior) {
          pushUnique(error);
        }
        for (const error of additionalErrors) {
          pushUnique(error);
        }

        return {
          success: false,
          stats,
          errors: errors.length > 0 ? errors : undefined,
          metrics: snapshotMetrics(),
        } satisfies PipelineResult;
      });
    const recordError = (error: unknown) =>
      Ref.update(errorsRef, (errors) =>
        errors.includes(error) ? errors : [...errors, error],
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

    const processMessage = (msg: Message) => {
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

      return pipe(
        runProcessorChain(msg, pipeline.processors),
        Effect.flatMap((messages) =>
          pipe(
            Effect.forEach(
              messages,
              (message) =>
                pipe(
                  pipeline.output.send(message),
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
                processMessage(message).pipe(
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
          yield* recordError(closeResult.left);
          if (!(yield* Deferred.isDone(fatalHalt))) {
            // Non-fatal path: preserve prior external close-failure behavior.
            return yield* Effect.fail(closeResult.left);
          }
        }

        const stats = yield* Ref.get(statsRef);
        const errors = yield* Ref.get(errorsRef);
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
        return {
          success: finalStats.failed === 0,
          stats: finalStats,
          errors: errors.length > 0 ? errors : undefined,
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

    const interruptFatalDrain = (): Effect.Effect<PipelineResult, never, R> =>
      Effect.gen(function* () {
        // Interrupt stuck workers / blocked finish-current pulls, then close.
        // Await interruption so FiberSet/scope finalizers settle before close.
        yield* Fiber.interrupt(executionFiber);
        const closeResult = yield* Effect.either(ensureClose);
        const drainTimeout = new PipelineFatalDrainTimeoutError();
        yield* recordError(drainTimeout);
        if (closeResult._tag === "Left") {
          yield* recordError(closeResult.left);
        }
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
      // External timeout/force may win after fatal was recorded. Rebuild from
      // the fatal channel so shutdown metadata cannot replace the fatal cause.
      const fatalResult = yield* fatalFailedResult(result.errors ?? []);
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
