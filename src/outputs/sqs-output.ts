/**
 * SQS Output - Sends messages to AWS SQS (works with LocalStack)
 */
import { Deferred, Duration, Effect, Ref, Schedule } from "effect";
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
  readonly batchTimeout?: number; // Maximum linger before flushing a partial batch (default: 100ms)
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

const DEFAULT_BATCH_TIMEOUT_MS = 100;

interface PendingBatchMessage {
  readonly message: Message;
  readonly completion: Deferred.Deferred<void, SqsOutputError>;
}

interface BatchTimer {
  readonly cancel: Deferred.Deferred<void>;
}

interface EnqueueResult {
  readonly batch: readonly PendingBatchMessage[] | undefined;
  readonly shouldStartTimer: boolean;
}

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

  // Batch mode. Every send waits on its own completion so the pipeline cannot
  // acknowledge the source message until SQS has accepted that batch entry.
  const batchRef = Ref.unsafeMake<PendingBatchMessage[]>([]);
  const batchTimerRef = Ref.unsafeMake<BatchTimer | null>(null);
  const metrics = new MetricsAccumulator("sqs-output");
  const batchTimeout = config.batchTimeout ?? DEFAULT_BATCH_TIMEOUT_MS;

  const completeEntries = (entries: readonly PendingBatchMessage[]) =>
    Effect.forEach(
      entries,
      (entry) => Deferred.succeed(entry.completion, undefined),
      { discard: true },
    );

  const failEntries = (
    entries: readonly PendingBatchMessage[],
    error: SqsOutputError,
  ) =>
    Effect.forEach(entries, (entry) => Deferred.fail(entry.completion, error), {
      discard: true,
    });

  const retryDelay = (attempt: number) =>
    Effect.sleep(Duration.seconds(2 ** attempt));

  const sendBatchEntries = (
    pending: readonly PendingBatchMessage[],
    retriesRemaining: number,
    retryAttempt = 0,
  ): Effect.Effect<void, SqsOutputError> =>
    Effect.gen(function* () {
      if (pending.length === 0) return;

      yield* Effect.logDebug(
        `Sending batch of ${pending.length} messages to SQS`,
      );

      const entries: SendMessageBatchRequestEntry[] = pending.map(
        (entry, index) => {
          const serialized = serializeMessage(
            entry.message,
            config.delaySeconds,
          );
          return {
            Id: index.toString(),
            MessageBody: serialized.body,
            MessageAttributes: serialized.attributes,
            DelaySeconds: serialized.delay,
          };
        },
      );

      const startedAt = performance.now();
      const attempt = yield* Effect.tryPromise({
        try: () => {
          const command = new SendMessageBatchCommand({
            QueueUrl: config.queueUrl,
            Entries: entries,
          });
          return client.send(command);
        },
        catch: (error) =>
          new SqsOutputError(
            `Failed to send batch to SQS: ${error instanceof Error ? error.message : String(error)}`,
            detectCategory(error),
            error,
          ),
      }).pipe(
        Effect.map((result) => ({ _tag: "Success" as const, result })),
        Effect.catchAll((error) =>
          Effect.succeed({ _tag: "Failure" as const, error }),
        ),
      );

      if (attempt._tag === "Failure") {
        if (retriesRemaining > 0) {
          yield* retryDelay(retryAttempt);
          return yield* sendBatchEntries(
            pending,
            retriesRemaining - 1,
            retryAttempt + 1,
          );
        }

        metrics.recordSendError();
        yield* failEntries(pending, attempt.error);
        yield* Effect.logError(
          `SQS batch send failed after ${retryAttempt} retries: ${attempt.error.message}`,
        );
        return yield* Effect.fail(attempt.error);
      }

      const failedById = new Map(
        (attempt.result.Failed ?? []).map((failure) => [failure.Id, failure]),
      );
      const accepted = pending.filter(
        (_, index) => !failedById.has(index.toString()),
      );
      const failed = pending.filter((_, index) =>
        failedById.has(index.toString()),
      );

      if (accepted.length > 0) {
        yield* completeEntries(accepted);
        metrics.recordBatch(accepted.length, performance.now() - startedAt);

        const metricsSnapshot = metrics.getOutputMetrics();
        if (metricsSnapshot.batchesSent % 10 === 0) {
          yield* emitOutputMetrics(metricsSnapshot);
        }
      }

      if (failed.length === 0) return;

      const failedIds = [...failedById.keys()].join(", ");
      const senderFault = [...failedById.values()].every(
        (failure) => failure.SenderFault === true,
      );
      const partialFailure = new SqsOutputError(
        `Failed to send ${failed.length} batch messages (IDs: ${failedIds})`,
        senderFault ? "logical" : "intermittent",
        attempt.result.Failed,
      );

      if (retriesRemaining > 0) {
        yield* retryDelay(retryAttempt);
        return yield* sendBatchEntries(
          failed,
          retriesRemaining - 1,
          retryAttempt + 1,
        );
      }

      metrics.recordSendError();
      yield* failEntries(failed, partialFailure);
      yield* Effect.logError(
        `SQS partial batch send failed after ${retryAttempt} retries: ${partialFailure.message}`,
      );
      return yield* Effect.fail(partialFailure);
    });

  const sendBatch = (entries: readonly PendingBatchMessage[]) =>
    sendBatchEntries(entries, config.maxRetries ?? 3);

  const cancelBatchTimer = Effect.gen(function* () {
    const timer = yield* Ref.getAndSet(batchTimerRef, null);
    if (timer) {
      yield* Deferred.succeed(timer.cancel, undefined);
    }
  });

  const startBatchTimer = Effect.gen(function* () {
    const cancel = yield* Deferred.make<void>();
    const timer: BatchTimer = { cancel };
    const installed = yield* Ref.modify(batchTimerRef, (current) =>
      current === null ? [true, timer] : [false, current],
    );
    if (!installed) return;

    const timerEffect = Effect.raceFirst(
      Effect.sleep(Duration.millis(batchTimeout)).pipe(Effect.as(true)),
      Deferred.await(cancel).pipe(Effect.as(false)),
    ).pipe(
      Effect.flatMap((expired) =>
        Ref.update(batchTimerRef, (current) =>
          current === timer ? null : current,
        ).pipe(
          Effect.zipRight(
            expired
              ? Effect.gen(function* () {
                  yield* Effect.logDebug(
                    `Batch timeout reached (${batchTimeout}ms), flushing batch`,
                  );
                  const batch = yield* Ref.getAndSet(batchRef, []);
                  if (batch.length === 0) return;

                  const result = yield* Effect.either(sendBatch(batch));
                  if (result._tag === "Left") {
                    yield* Effect.logError(
                      `Background SQS batch flush failed: ${result.left.message}`,
                    );
                  }
                })
              : Effect.void,
          ),
        ),
      ),
    );

    // The fiber never leaks a send failure: sendBatch settles each per-message
    // completion, and the timer observes/logs the aggregate failure.
    yield* Effect.forkDaemon(timerEffect);
  });

  const enqueue = (entry: PendingBatchMessage) =>
    Ref.modify(
      batchRef,
      (current): readonly [EnqueueResult, PendingBatchMessage[]] => {
        const next = [...current, entry];
        if (next.length >= batchSize) {
          return [{ batch: next, shouldStartTimer: false }, []];
        }
        return [
          {
            batch: undefined,
            shouldStartTimer: current.length === 0,
          },
          next,
        ];
      },
    );

  const cleanup = Effect.gen(function* () {
    yield* emitOutputMetrics(metrics.getOutputMetrics());
    yield* Effect.tryPromise({
      try: async () => {
        await client.destroy();
      },
      catch: () => undefined,
    }).pipe(Effect.catchAll(() => Effect.void));
  });

  return {
    name: "sqs-output",
    getMetrics: () => metrics.getOutputMetrics(),
    send: (msg: Message): Effect.Effect<void, SqsOutputError> =>
      Effect.gen(function* () {
        yield* Effect.logInfo(`Connected to SQS queue: ${config.queueUrl}`);

        const completion = yield* Deferred.make<void, SqsOutputError>();
        const pending: PendingBatchMessage = { message: msg, completion };
        const { batch, shouldStartTimer } = yield* enqueue(pending);

        if (batch) {
          yield* cancelBatchTimer;
          // Every entry receives its own success/failure below. Observing the
          // aggregate result prevents the coordinating sender from inheriting
          // another entry's failure.
          yield* Effect.either(sendBatch(batch));
        } else if (shouldStartTimer) {
          yield* startBatchTimer;
        }

        yield* Deferred.await(completion);
      }),
    close: () =>
      Effect.gen(function* () {
        yield* cancelBatchTimer;
        const remaining = yield* Ref.getAndSet(batchRef, []);
        if (remaining.length > 0) {
          // Propagate the final flush error. sendBatch also fails each waiting
          // sender so their source messages remain unacknowledged.
          yield* sendBatch(remaining);
        }
      }).pipe(Effect.ensuring(cleanup)),
  };
};
