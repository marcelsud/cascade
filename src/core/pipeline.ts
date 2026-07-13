/**
 * Pipeline orchestration using Effect.js
 */
import { Deferred, Effect, Fiber, FiberSet, Ref, Stream, pipe } from "effect";
import type {
  Message,
  Pipeline,
  PipelineResult,
  PipelineStats,
} from "./types.js";

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

    const statsRef = yield* Ref.make({
      processed: 0,
      failed: 0,
      startTime: Date.now(),
    });
    const errorsRef = yield* Ref.make<unknown[]>([]);
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
        };
      });
    const maxConcurrentMessages =
      pipeline.backpressure?.maxConcurrentMessages ?? 10;
    const maxConcurrentOutputs =
      pipeline.backpressure?.maxConcurrentOutputs ?? 5;

    const processMessage = (msg: Message) =>
      pipe(
        Effect.succeed(msg),
        Effect.flatMap((currentMsg) =>
          Effect.reduce(
            pipeline.processors,
            currentMsg as Message | Message[],
            (acc, processor) => {
              const messages = Array.isArray(acc) ? acc : [acc];
              return pipe(
                Effect.forEach(
                  messages,
                  (message) => processor.process(message),
                  {
                    concurrency: 1,
                  },
                ),
                Effect.map((results) => results.flat()),
              );
            },
          ),
        ),
        Effect.map((result) => (Array.isArray(result) ? result : [result])),
        Effect.flatMap((messages) =>
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
        ),
        Effect.tap(() => (msg.ack ? msg.ack() : Effect.void)),
        Effect.catchAll((error) =>
          Effect.gen(function* () {
            yield* Ref.update(statsRef, (stats) => ({
              ...stats,
              failed: stats.failed + 1,
            }));
            yield* Ref.update(errorsRef, (errors) => [...errors, error]);
            yield* Effect.logError(`Message processing failed: ${error}`);
          }),
        ),
        Effect.withSpan("process-message", {
          attributes: { messageId: msg.id },
        }),
      );

    const execution = Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.log(`Starting pipeline: ${pipeline.name}`);
        const workers = yield* FiberSet.make<void, never>();
        const permits = yield* Effect.makeSemaphore(maxConcurrentMessages);

        yield* pipeline.input.stream.pipe(
          Stream.interruptWhenDeferred(shutdown.stop),
          Stream.runForEach((message) =>
            Effect.gen(function* () {
              yield* permits.take(1);
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
              yield* Ref.update(errorsRef, (errors) => [...errors, error]);
            }),
          ),
        );

        yield* FiberSet.awaitEmpty(workers);
        yield* closePipeline(pipeline, shutdownTimeoutMs);

        const stats = yield* Ref.get(statsRef);
        const errors = yield* Ref.get(errorsRef);
        const finalStats: PipelineStats = {
          processed: stats.processed,
          failed: stats.failed,
          duration: Date.now() - stats.startTime,
          startTime: stats.startTime,
          endTime: Date.now(),
        };

        yield* Effect.log(
          `Pipeline completed: ${finalStats.processed} processed, ${finalStats.failed} failed in ${finalStats.duration}ms`,
        );
        return {
          success: finalStats.failed === 0,
          stats: finalStats,
          errors: errors.length > 0 ? errors : undefined,
        } satisfies PipelineResult;
      }),
    );

    const executionFiber = yield* Effect.forkDaemon(execution);
    const interruptedResult = (
      reason: "timed-out" | "forced",
    ): Effect.Effect<PipelineResult> =>
      Effect.gen(function* () {
        yield* Effect.forkDaemon(Fiber.interrupt(executionFiber));
        return yield* failedResult(new PipelineShutdownError(reason), reason);
      });

    const result: PipelineResult = yield* Effect.raceFirst(
      Fiber.join(executionFiber),
      Deferred.await(shutdown.stop).pipe(
        Effect.flatMap(() =>
          Effect.raceFirst(
            Effect.raceFirst(
              Fiber.join(executionFiber).pipe(
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
    ).pipe(
      Effect.catchAll((error: unknown) =>
        failedResult(
          error,
          error instanceof PipelineShutdownError ? error.shutdown : undefined,
        ),
      ),
    );
    const shutdownRequested = yield* Deferred.isDone(shutdown.stop);
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
