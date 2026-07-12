/**
 * Dead Letter Queue (DLQ) support for outputs
 * Handles retry logic and sends failed messages to DLQ after max retries
 */
import { Effect, Schedule } from "effect";
import type { Output, Message } from "./types.js";
import { ComponentError, type ErrorCategory } from "./errors.js";

export class DLQError extends ComponentError {
  readonly _tag = "DLQError";

  constructor(
    message: string,
    readonly category: ErrorCategory,
    cause?: unknown,
  ) {
    super(message, cause);
  }
}

export interface DLQConfig<E> {
  readonly output: Output<E>; // Primary output
  readonly dlq?: Output<any>; // Dead letter queue output
  readonly maxRetries?: number; // Max retries before DLQ (default: 3)
  readonly retrySchedule?: Schedule.Schedule<number>; // Custom retry schedule
}

/**
 * Create a DLQ message with failure information
 */
const createDLQMessage = (
  originalMessage: Message,
  error: unknown,
  attemptCount: number,
): Message => {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorStack = error instanceof Error ? error.stack : undefined;

  return {
    ...originalMessage,
    metadata: {
      ...originalMessage.metadata,
      dlq: true,
      dlqReason: errorMessage,
      dlqStack: errorStack,
      dlqTimestamp: Date.now(),
      dlqAttempts: attemptCount,
      originalMessageId: originalMessage.id,
    },
  };
};

/**
 * Wrap an output with DLQ support
 */
export const withDLQ = <E>(config: DLQConfig<E>): Output<E | DLQError> => {
  const maxRetries = config.maxRetries ?? 3;
  const retrySchedule =
    config.retrySchedule ?? Schedule.exponential("1 second");
  const closeOutputs = [config.output.close, config.dlq?.close].filter(
    (close): close is NonNullable<typeof close> => close !== undefined,
  );

  return {
    name: `${config.output.name}-with-dlq`,
    send: (msg: Message): Effect.Effect<void, E | DLQError> =>
      Effect.gen(function* () {
        // Try sending with retry logic
        const sendWithRetry = config.output.send(msg).pipe(
          Effect.retry({
            times: maxRetries,
            schedule: retrySchedule,
          }),
        );

        // If send fails after retries, send to DLQ
        yield* sendWithRetry.pipe(
          Effect.catchAll((error) =>
            Effect.gen(function* () {
              if (config.dlq) {
                yield* Effect.logWarning(
                  `Message ${msg.id} failed after ${maxRetries} retries, sending to DLQ: ${error}`,
                );

                const dlqMessage = createDLQMessage(msg, error, maxRetries + 1);

                // Send to DLQ (without retry to avoid infinite loops)
                yield* config.dlq.send(dlqMessage).pipe(
                  Effect.catchAll((dlqError) =>
                    Effect.gen(function* () {
                      yield* Effect.logError(
                        `Failed to send message ${msg.id} to DLQ: ${dlqError}`,
                      );
                      // Re-throw original error since DLQ also failed
                      return yield* Effect.fail(error as E);
                    }),
                  ),
                );
              } else {
                // No DLQ configured, just fail
                return yield* Effect.fail(error as E);
              }
            }),
          ),
        );
      }),
    close:
      closeOutputs.length > 0
        ? () =>
            Effect.all(
              closeOutputs.map((close) => close()),
              {
                concurrency: "unbounded",
                discard: true,
              },
            )
        : undefined,
  };
};

/**
 * Configuration for output-level backpressure control
 */
export interface OutputBackpressureConfig<E> {
  readonly output: Output<E>;
  readonly maxConcurrent?: number; // Max concurrent sends (default: 10)
  readonly bufferSize?: number; // Buffer size for pending messages (default: 100)
}

/**
 * Wrap an output with backpressure control
 * Note: Concurrency control is handled by the pipeline runner
 */
export const withBackpressure = <E>(
  config: OutputBackpressureConfig<E>,
): Output<E> => {
  return {
    name: `${config.output.name}-with-backpressure`,
    send: (msg: Message): Effect.Effect<void, E> =>
      Effect.gen(function* () {
        // Send to underlying output (concurrency handled by caller)
        yield* config.output.send(msg);
      }),
    close: config.output.close,
  };
};
