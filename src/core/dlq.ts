/**
 * Dead Letter Queue (DLQ) support for outputs
 * Handles category-aware retry logic and routes failed messages to the DLQ
 */
import { Duration, Effect, Schedule } from "effect";
import type { Output, Message } from "./types.js";
import {
  ComponentError,
  getErrorCategory,
  isFatalError,
  isIntermittentError,
  type ErrorCategory,
} from "./errors.js";
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
  readonly retrySchedule?: Schedule.Schedule<unknown>; // Custom retry schedule
}

export type DLQRetrySchedule = "exponential" | "fixed" | "linear";

export const createDLQRetrySchedule = (
  type: DLQRetrySchedule = "exponential",
  intervalMs = 1_000,
): Schedule.Schedule<unknown> => {
  const interval = Duration.millis(intervalMs);
  switch (type) {
    case "fixed":
      return Schedule.spaced(interval);
    case "linear":
      return Schedule.linear(interval);
    case "exponential":
      return Schedule.exponential(interval);
  }
};

/**
 * Create a DLQ message with failure information
 */
export const createDLQMessage = (
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
  const retrySchedule = config.retrySchedule ?? createDLQRetrySchedule();
  const closeOutputs = [config.output.close, config.dlq?.close].filter(
    (close): close is NonNullable<typeof close> => close !== undefined,
  );

  return {
    name: `${config.output.name}-with-dlq`,
    send: (msg: Message): Effect.Effect<void, E | DLQError> =>
      Effect.gen(function* () {
        let attempts = 0;

        // Count every primary send, including the first attempt.
        const sendOnce = Effect.suspend(() => {
          attempts += 1;
          return config.output.send(msg);
        });

        // Only intermittent failures consume the configured retry budget.
        const sendWithRetry = sendOnce.pipe(
          Effect.retry({
            times: maxRetries,
            schedule: retrySchedule,
            while: (error) => isIntermittentError(error),
          }),
        );

        yield* sendWithRetry.pipe(
          Effect.catchAll((error) =>
            Effect.gen(function* () {
              const category = getErrorCategory(error);

              if (config.dlq) {
                yield* Effect.logWarning(
                  `Message ${msg.id} failed after ${attempts} attempt(s), sending to DLQ: ${error}`,
                );

                const dlqMessage = createDLQMessage(msg, error, attempts);

                // Send to DLQ (without retry to avoid infinite loops)
                yield* config.dlq.send(dlqMessage).pipe(
                  Effect.catchAll((dlqError) =>
                    Effect.gen(function* () {
                      yield* Effect.logError(
                        `Failed to send message ${msg.id} to DLQ: ${dlqError}`,
                      );
                      // Fatal DLQ failures must surface as fatal (not mask).
                      if (isFatalError(dlqError)) {
                        return yield* Effect.fail(dlqError as E);
                      }
                      // Nonfatal DLQ failure: keep the original primary error.
                      return yield* Effect.fail(error as E);
                    }),
                  ),
                );

                // Logical (and exhausted intermittent) resolve after DLQ copy.
                // Fatal may be archived but must still fail the send.
                if (category === "fatal") {
                  return yield* Effect.fail(error as E);
                }
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
            Effect.gen(function* () {
              // Closing one output must not interrupt cleanup of the other.
              const results = yield* Effect.all(
                closeOutputs.map((close) => Effect.either(close())),
                { concurrency: "unbounded" },
              );
              const failure = results.find((result) => result._tag === "Left");
              if (failure?._tag === "Left") {
                return yield* Effect.fail(failure.left);
              }
            })
        : undefined,
    getMetrics: config.output.getMetrics,
    getDLQMetrics: config.dlq?.getMetrics,
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
    getMetrics: config.output.getMetrics,
    getDLQMetrics: config.output.getDLQMetrics,
  };
};
