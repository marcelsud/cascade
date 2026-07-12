/**
 * Pipeline orchestration using Effect.js
 */
import { Effect, Stream, pipe, Ref } from "effect";
import type {
  Message,
  Pipeline,
  PipelineStats,
  PipelineResult,
} from "./types.js";

/**
 * Pipeline execution errors
 */
export class PipelineError {
  readonly _tag = "PipelineError";
  constructor(
    readonly message: string,
    readonly cause?: unknown,
  ) {}
}

/**
 * Run a pipeline
 * Orchestrates the flow: Input → Processors → Output
 */
export const run = <E, R>(
  pipeline: Pipeline<E, R>,
): Effect.Effect<PipelineResult, PipelineError, R> => {
  return Effect.gen(function* () {
    // Initialize stats
    const statsRef = yield* Ref.make({
      processed: 0,
      failed: 0,
      startTime: Date.now(),
    });

    const errorsRef = yield* Ref.make<unknown[]>([]);

    // Get backpressure config
    const maxConcurrentMessages =
      pipeline.backpressure?.maxConcurrentMessages ?? 10;
    const maxConcurrentOutputs =
      pipeline.backpressure?.maxConcurrentOutputs ?? 5;

    yield* Effect.log(`Starting pipeline: ${pipeline.name}`);

    // Execute pipeline
    yield* pipe(
      pipeline.input.stream,

      // Apply processors with concurrency control
      Stream.mapEffect(
        (msg: Message) =>
          pipe(
            // Start with the message
            Effect.succeed(msg),

            // Apply each processor in sequence
            Effect.flatMap((currentMsg) =>
              Effect.reduce(
                pipeline.processors,
                currentMsg as Message | Message[],
                (acc, processor) => {
                  // Handle both single message and array of messages
                  const messages = Array.isArray(acc) ? acc : [acc];

                  return pipe(
                    Effect.forEach(messages, (m) => processor.process(m), {
                      concurrency: 1,
                    }),
                    Effect.map((results) => results.flat()),
                  );
                },
              ),
            ),

            // Flatten if array
            Effect.map((result) => (Array.isArray(result) ? result : [result])),

            // Send each message to output with backpressure
            Effect.flatMap((messages) =>
              Effect.forEach(
                messages,
                (msg) =>
                  pipe(
                    pipeline.output.send(msg),
                    Effect.tap(() =>
                      Ref.update(statsRef, (s) => ({
                        ...s,
                        processed: s.processed + 1,
                      })),
                    ),
                  ),
                { concurrency: maxConcurrentOutputs },
              ),
            ),

            // Acknowledge the original input only after every fan-out send
            // succeeds. DLQ-wrapped outputs succeed only after DLQ delivery.
            Effect.flatMap(() => (msg.ack ? msg.ack() : Effect.void)),

            // Handle errors per message
            Effect.catchAll((error) =>
              Effect.gen(function* () {
                yield* Ref.update(statsRef, (s) => ({
                  ...s,
                  failed: s.failed + 1,
                }));
                yield* Ref.update(errorsRef, (errors) => [...errors, error]);
                yield* Effect.logError(`Message processing failed: ${error}`);
                return [];
              }),
            ),

            // Add span for telemetry
            Effect.withSpan("process-message", {
              attributes: { messageId: msg.id },
            }),
          ),
        { concurrency: maxConcurrentMessages },
      ),

      // Drain the stream
      Stream.runDrain,

      // Handle stream errors
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          yield* Effect.logError(`Pipeline stream error: ${error}`);
          yield* Ref.update(errorsRef, (errors) => [...errors, error]);
        }),
      ),
    );

    // Finalize stats
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

    // Close resources
    if (pipeline.input.close) {
      yield* pipeline.input.close();
    }
    if (pipeline.output.close) {
      yield* pipeline.output.close();
    }

    return {
      success: finalStats.failed === 0,
      stats: finalStats,
      errors: errors.length > 0 ? errors : undefined,
    };
  }).pipe(
    Effect.catchAll((error) =>
      Effect.succeed({
        success: false,
        stats: {
          processed: 0,
          failed: 0,
          duration: 0,
          startTime: Date.now(),
          endTime: Date.now(),
        },
        errors: [error],
      }),
    ),
  );
};

/**
 * Create a pipeline from configuration
 */
export const create = <E, R>(config: {
  name: string;
  input: Pipeline<E, R>["input"];
  processors: Pipeline<E, R>["processors"];
  output: Pipeline<E, R>["output"];
}): Pipeline<E, R> => config;
