/**
 * SQS Output - Sends messages to AWS SQS (works with LocalStack)
 */
import { Effect, Ref, Schedule, Fiber, Duration } from "effect";
import * as Schema from "effect/Schema";
import {
  SQSClient,
  SendMessageCommand,
  SendMessageBatchCommand,
  type SendMessageBatchRequestEntry,
} from "@aws-sdk/client-sqs";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import type { Output, Message } from "../core/types.js";
import {
  ComponentError,
  type ErrorCategory,
  detectCategory,
} from "../core/errors.js";
import {
  MetricsAccumulator,
  emitOutputMetrics,
  measureDuration,
} from "../core/metrics.js";
import {
  validate,
  NonEmptyString,
  AwsRegion,
  TimeoutMs,
  SqsBatchSize,
  RetryCount,
  UrlString,
} from "../core/validation.js";

export interface SqsOutputConfig {
  readonly queueUrl: string;
  readonly region?: string;
  readonly endpoint?: string;
  readonly maxBatchSize?: number; // 1 = single sends, up to 10 for batch
  readonly delaySeconds?: number; // Optional message delay
  readonly maxRetries?: number; // Retry count (default 3)
  readonly batchTimeout?: number; // Timeout in milliseconds to auto-flush batch (default: no timeout)
  // Connection configuration
  readonly maxAttempts?: number; // Max retry attempts (default: 3)
  readonly requestTimeout?: number; // Request timeout in ms (default: 0 = no timeout)
  readonly connectionTimeout?: number; // Connection timeout in ms (default: 1000)
}

export class SqsOutputError extends ComponentError {
  readonly _tag = "SqsOutputError";

  constructor(
    message: string,
    readonly category: ErrorCategory,
    cause?: unknown,
  ) {
    super(message, cause);
  }
}

/**
 * Validation schema for SQS Output configuration
 */
export const SqsOutputConfigSchema = Schema.Struct({
  queueUrl: NonEmptyString,
  region: Schema.optional(Schema.Union(AwsRegion, NonEmptyString)),
  endpoint: Schema.optional(Schema.Union(UrlString, NonEmptyString)),
  maxBatchSize: Schema.optional(SqsBatchSize),
  delaySeconds: Schema.optional(Schema.Int.pipe(Schema.between(0, 900))),
  maxRetries: Schema.optional(RetryCount),
  batchTimeout: Schema.optional(Schema.Int.pipe(Schema.positive())),
  maxAttempts: Schema.optional(RetryCount),
  requestTimeout: Schema.optional(Schema.Int.pipe(Schema.nonNegative())),
  connectionTimeout: Schema.optional(TimeoutMs),
});

/**
 * Serialize Message to SQS format
 */
const serializeMessage = (
  msg: Message,
  delaySeconds?: number,
): { body: string; attributes: Record<string, any>; delay?: number } => ({
  body: JSON.stringify(msg.content),
  attributes: {
    messageId: { StringValue: msg.id, DataType: "String" },
    timestamp: { StringValue: msg.timestamp.toString(), DataType: "Number" },
    correlationId: msg.correlationId
      ? { StringValue: msg.correlationId, DataType: "String" }
      : undefined,
    metadata: { StringValue: JSON.stringify(msg.metadata), DataType: "String" },
    trace: msg.trace
      ? { StringValue: JSON.stringify(msg.trace), DataType: "String" }
      : undefined,
  },
  delay: delaySeconds,
});

/**
 * Create an SQS output destination
 */
export const createSqsOutput = (
  config: SqsOutputConfig,
): Output<SqsOutputError> => {
  // Validate configuration synchronously at creation time
  Effect.runSync(
    validate(SqsOutputConfigSchema, config, "SQS Output configuration").pipe(
      Effect.catchAll((error) =>
        Effect.fail(new SqsOutputError(error.message, error.category, error)),
      ),
    ),
  );

  const client = new SQSClient({
    region: config.region || "us-east-1",
    endpoint: config.endpoint,
    credentials: config.endpoint
      ? {
          accessKeyId: "test",
          secretAccessKey: "test",
        }
      : undefined,
    maxAttempts: config.maxAttempts ?? 3,
    requestHandler: new NodeHttpHandler({
      requestTimeout: config.requestTimeout ?? 0,
      connectionTimeout: config.connectionTimeout ?? 1000,
      socketTimeout: config.requestTimeout ?? 0,
    }),
  });

  const batchSize = config.maxBatchSize ?? 1;

  // Single message mode (no batching)
  if (batchSize === 1) {
    const metrics = new MetricsAccumulator("sqs-output");
    let messageCount = 0;

    return {
      name: "sqs-output",
      getMetrics: () => metrics.getOutputMetrics(),
      send: (msg: Message): Effect.Effect<void, SqsOutputError> =>
        Effect.gen(function* () {
          const serialized = serializeMessage(msg, config.delaySeconds);

          yield* Effect.logInfo(`Connected to SQS queue: ${config.queueUrl}`);

          const sendEffect = Effect.tryPromise({
            try: async () => {
              const command = new SendMessageCommand({
                QueueUrl: config.queueUrl,
                MessageBody: serialized.body,
                MessageAttributes: serialized.attributes,
                DelaySeconds: serialized.delay,
              });
              return await client.send(command);
            },
            catch: (error) =>
              new SqsOutputError(
                `Failed to send message to SQS: ${error instanceof Error ? error.message : String(error)}`,
                detectCategory(error),
                error,
              ),
          });

          const retryCount = config.maxRetries ?? 3;
          const [_, duration] = yield* measureDuration(
            retryCount > 0
              ? sendEffect.pipe(
                  Effect.retry({
                    times: retryCount,
                    schedule: Schedule.exponential("1 second"),
                  }),
                  Effect.tapError((error) => {
                    metrics.recordSendError();
                    return Effect.logError(
                      `SQS send failed after ${retryCount} retries: ${error.message}`,
                    );
                  }),
                )
              : sendEffect,
          );

          // Record successful send
          metrics.recordSent(1, duration);
          messageCount++;

          // Emit metrics every 100 messages
          if (messageCount >= 100) {
            yield* emitOutputMetrics(metrics.getOutputMetrics());
            messageCount = 0;
          }

          yield* Effect.logDebug(`Sent message to SQS: ${msg.id}`);
        }),
      close: () =>
        Effect.gen(function* () {
          // Emit final metrics
          if (messageCount > 0) {
            yield* emitOutputMetrics(metrics.getOutputMetrics());
          }
          yield* Effect.tryPromise({
            try: async () => {
              await client.destroy();
            },
            catch: () => undefined,
          }).pipe(Effect.catchAll(() => Effect.void));
        }),
    };
  }

  // Batch mode (accumulate and send)
  // Use unsafeMake to create Ref synchronously
  const batchRef = Ref.unsafeMake<Message[]>([]);
  const timeoutFiberRef = Ref.unsafeMake<Fiber.RuntimeFiber<
    void,
    SqsOutputError
  > | null>(null);
  const metrics = new MetricsAccumulator("sqs-output");

  const sendBatch = (
    messages: Message[],
  ): Effect.Effect<void, SqsOutputError> =>
    Effect.gen(function* () {
      if (messages.length === 0) return;

      yield* Effect.logDebug(
        `Sending batch of ${messages.length} messages to SQS`,
      );

      const entries: SendMessageBatchRequestEntry[] = messages.map(
        (msg, index) => {
          const serialized = serializeMessage(msg, config.delaySeconds);
          return {
            Id: index.toString(),
            MessageBody: serialized.body,
            MessageAttributes: serialized.attributes,
            DelaySeconds: serialized.delay,
          };
        },
      );

      const batchEffect = Effect.tryPromise({
        try: async () => {
          const command = new SendMessageBatchCommand({
            QueueUrl: config.queueUrl,
            Entries: entries,
          });
          const result = await client.send(command);

          // Check for partial failures
          if (result.Failed && result.Failed.length > 0) {
            const failedIds = result.Failed.map((f) => f.Id).join(", ");
            throw new Error(
              `Failed to send ${result.Failed.length} messages (IDs: ${failedIds})`,
            );
          }

          return result;
        },
        catch: (error) =>
          new SqsOutputError(
            `Failed to send batch to SQS: ${error instanceof Error ? error.message : String(error)}`,
            detectCategory(error),
            error,
          ),
      });

      const retryCount = config.maxRetries ?? 3;
      const [_, duration] = yield* measureDuration(
        retryCount > 0
          ? batchEffect.pipe(
              Effect.retry({
                times: retryCount,
                schedule: Schedule.exponential("1 second"),
              }),
              Effect.tapError((error) => {
                metrics.recordSendError();
                return Effect.logError(
                  `SQS batch send failed after ${retryCount} retries: ${error.message}`,
                );
              }),
            )
          : batchEffect,
      );

      // Record successful batch send
      metrics.recordBatch(messages.length, duration);

      // Emit metrics every 10 batches
      const metricsSnapshot = metrics.getOutputMetrics();
      if (metricsSnapshot.batchesSent % 10 === 0) {
        yield* emitOutputMetrics(metricsSnapshot);
      }
    });

  // Flush the current batch and cancel any pending timeout
  const flushBatch = Effect.gen(function* () {
    // Clear timeout fiber reference first, then interrupt
    const timeoutFiber = yield* Ref.getAndSet(timeoutFiberRef, null);
    if (timeoutFiber) {
      yield* Fiber.interrupt(timeoutFiber);
    }

    // Get and clear batch
    const batch = yield* Ref.getAndSet(batchRef, []);
    if (batch.length > 0) {
      yield* sendBatch(batch);
    }
  });

  // Start timeout fiber for batch flush
  const startBatchTimeout = Effect.gen(function* () {
    if (!config.batchTimeout) return;

    // Only start timeout if no fiber is running
    const existing = yield* Ref.get(timeoutFiberRef);
    if (existing) return;

    const timeoutEffect = Effect.gen(function* () {
      yield* Effect.sleep(Duration.millis(config.batchTimeout!));
      yield* Effect.logDebug(
        `Batch timeout reached (${config.batchTimeout}ms), flushing batch`,
      );

      // Flush batch on timeout
      const batch = yield* Ref.getAndSet(batchRef, []);
      if (batch.length > 0) {
        yield* sendBatch(batch);
      }

      // Clear timeout fiber reference
      yield* Ref.set(timeoutFiberRef, null);
    });

    // Fork daemon fiber to outlive parent scope
    const fiber = yield* Effect.forkDaemon(timeoutEffect);
    yield* Ref.set(timeoutFiberRef, fiber);
  });

  return {
    name: "sqs-output",
    getMetrics: () => metrics.getOutputMetrics(),
    send: (msg: Message): Effect.Effect<void, SqsOutputError> =>
      Effect.gen(function* () {
        yield* Effect.logInfo(`Connected to SQS queue: ${config.queueUrl}`);

        // Add message to batch atomically
        const oldBatch = yield* Ref.get(batchRef);
        const wasEmpty = oldBatch.length === 0;

        const newBatch = yield* Ref.updateAndGet(batchRef, (batch) => [
          ...batch,
          msg,
        ]);

        // Start timeout if this is the first message in an empty batch
        if (wasEmpty && config.batchTimeout) {
          yield* startBatchTimeout;
        }

        // Send if batch is full
        if (newBatch.length >= batchSize) {
          yield* flushBatch;
        }
      }),
    close: () =>
      Effect.gen(function* () {
        // Cancel any pending timeout
        const timeoutFiber = yield* Ref.get(timeoutFiberRef);
        if (timeoutFiber) {
          yield* Fiber.interrupt(timeoutFiber);
        }

        // Flush remaining messages
        const remaining = yield* Ref.get(batchRef);
        if (remaining.length > 0) {
          yield* sendBatch(remaining).pipe(Effect.catchAll(() => Effect.void));
        }

        // Emit final metrics
        yield* emitOutputMetrics(metrics.getOutputMetrics());

        yield* Effect.tryPromise({
          try: async () => {
            await client.destroy();
          },
          catch: () => undefined,
        }).pipe(Effect.catchAll(() => Effect.void));
      }),
  };
};
