/**
 * SQS Input - Consumes messages from AWS SQS (works with LocalStack)
 */
import { Effect, Stream, Schedule } from "effect";
import * as Schema from "effect/Schema";
import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  type Message as SQSMessage,
} from "@aws-sdk/client-sqs";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import type { Input, Message } from "../core/types.js";
import { createMessage } from "../core/types.js";
import {
  ComponentError,
  type ErrorCategory,
  detectCategory,
} from "../core/errors.js";
import {
  MetricsAccumulator,
  emitInputMetrics,
  measureDuration,
} from "../core/metrics.js";
import {
  validate,
  NonEmptyString,
  AwsRegion,
  TimeoutMs,
  SqsMaxMessages,
  RetryCount,
  UrlString,
} from "../core/validation.js";

export interface SqsInputConfig {
  readonly queueUrl: string;
  readonly region?: string;
  readonly endpoint?: string;
  readonly waitTimeSeconds?: number;
  readonly maxMessages?: number;
  // Connection configuration
  readonly maxAttempts?: number; // Max retry attempts (default: 3)
  readonly requestTimeout?: number; // Request timeout in ms (default: 0 = no timeout)
  readonly connectionTimeout?: number; // Connection timeout in ms (default: 1000)
}

/**
 * Validation schema for SQS Input configuration
 */
export const SqsInputConfigSchema = Schema.Struct({
  queueUrl: NonEmptyString,
  region: Schema.optional(Schema.Union(AwsRegion, NonEmptyString)),
  endpoint: Schema.optional(Schema.Union(UrlString, NonEmptyString)),
  waitTimeSeconds: Schema.optional(Schema.Int.pipe(Schema.between(0, 20))),
  maxMessages: Schema.optional(SqsMaxMessages),
  maxAttempts: Schema.optional(RetryCount),
  requestTimeout: Schema.optional(Schema.Int.pipe(Schema.nonNegative())),
  connectionTimeout: Schema.optional(TimeoutMs),
});

export class SqsInputError extends ComponentError {
  readonly _tag = "SqsInputError";

  constructor(
    message: string,
    readonly category: ErrorCategory,
    cause?: unknown,
  ) {
    super(message, cause);
  }
}

export interface SqsClientLike {
  readonly send: (
    command: ReceiveMessageCommand | DeleteMessageCommand,
  ) => Promise<unknown>;
  readonly destroy: () => void;
}

/**
 * Create an SQS input source
 */
export const createSqsInput = (
  config: SqsInputConfig,
  clientOverride?: SqsClientLike,
): Input<SqsInputError> => {
  // Validate configuration synchronously at creation time
  Effect.runSync(
    validate(SqsInputConfigSchema, config, "SQS Input configuration").pipe(
      Effect.catchAll((error) =>
        Effect.fail(new SqsInputError(error.message, error.category, error)),
      ),
    ),
  );

  const client: SqsClientLike =
    clientOverride ??
    (new SQSClient({
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
    }) as SqsClientLike);

  // Metrics tracking
  const metrics = new MetricsAccumulator("sqs-input");
  let messageCount = 0;

  /**
   * Poll SQS for messages with retry logic
   */
  const pollMessages = (): Effect.Effect<SQSMessage[], SqsInputError> => {
    return Effect.tryPromise({
      try: async () => {
        const command = new ReceiveMessageCommand({
          QueueUrl: config.queueUrl,
          MaxNumberOfMessages: config.maxMessages || 10,
          WaitTimeSeconds: config.waitTimeSeconds || 20,
        });

        const response = await client.send(command);
        if (
          response !== null &&
          typeof response === "object" &&
          "Messages" in response &&
          Array.isArray(response.Messages)
        ) {
          return response.Messages as SQSMessage[];
        }
        return [];
      },
      catch: (error) =>
        new SqsInputError(
          "Failed to receive messages from SQS",
          detectCategory(error),
          error,
        ),
    }).pipe(
      Effect.retry({
        times: 3,
        schedule: Schedule.exponential("1 second"),
      }),
      Effect.tapError((error) =>
        Effect.logError(`SQS polling failed after 3 retries: ${error.message}`),
      ),
    );
  };

  /**
   * Delete message from SQS after processing
   */
  const deleteMessage = (
    receiptHandle: string,
  ): Effect.Effect<void, SqsInputError> => {
    return Effect.tryPromise({
      try: async () => {
        const command = new DeleteMessageCommand({
          QueueUrl: config.queueUrl,
          ReceiptHandle: receiptHandle,
        });
        await client.send(command);
      },
      catch: (error) =>
        new SqsInputError(
          "Failed to delete message from SQS",
          detectCategory(error),
          error,
        ),
    });
  };

  /**
   * Convert SQS message to our Message format
   */
  const convertMessage = (sqsMsg: SQSMessage): Message => {
    let content: unknown;
    try {
      content = sqsMsg.Body ? JSON.parse(sqsMsg.Body) : {};
    } catch {
      content = { raw: sqsMsg.Body };
    }

    const receiptHandle = sqsMsg.ReceiptHandle;
    return {
      ...createMessage(content, {
        source: "sqs-input",
        externalId: sqsMsg.MessageId,
        receivedAt: new Date().toISOString(),
        sqsMessageId: sqsMsg.MessageId,
        receiptHandle,
        attributes: sqsMsg.Attributes,
        messageAttributes: sqsMsg.MessageAttributes,
      }),
      ack: receiptHandle
        ? () =>
            deleteMessage(receiptHandle).pipe(
              Effect.tapError(() =>
                Effect.sync(() => {
                  metrics.recordError();
                }),
              ),
            )
        : undefined,
    };
  };

  /**
   * Create a stream that continuously polls SQS
   */
  const stream = Stream.repeatEffect(
    Effect.gen(function* () {
      yield* Effect.logInfo("Polling SQS for messages...");

      const [sqsMessages, pollDuration] =
        yield* measureDuration(pollMessages());

      if (sqsMessages.length === 0) {
        yield* Effect.logDebug("No messages received, continuing to poll...");
        return [];
      }

      yield* Effect.logDebug(
        `Received ${sqsMessages.length} messages from SQS`,
      );

      // Convert messages. Deletion is deferred to the pipeline acknowledgement
      // after all downstream processing and output delivery succeeds.
      const [messages, processDuration] = yield* measureDuration(
        Effect.forEach(sqsMessages, (sqsMsg) =>
          Effect.succeed(convertMessage(sqsMsg)),
        ),
      );

      // Record metrics
      const totalDuration = pollDuration + processDuration;
      messages.forEach(() => {
        metrics.recordProcessed(totalDuration / messages.length);
        messageCount++;
      });

      // Emit metrics every 100 messages
      if (messageCount >= 100) {
        yield* emitInputMetrics(metrics.getInputMetrics());
        messageCount = 0;
      }

      return messages;
    }),
  ).pipe(
    Stream.flatMap((messages) => Stream.fromIterable(messages)),
    Stream.catchAll((error) =>
      Stream.fromEffect(
        Effect.gen(function* () {
          metrics.recordError();
          yield* Effect.logError(`SQS stream error: ${error}`);
          // Wait before retrying
          yield* Effect.sleep("5 seconds");
          return [] as Message[];
        }),
      ).pipe(Stream.flatMap((msgs) => Stream.fromIterable(msgs))),
    ),
  );

  return {
    name: "sqs-input",
    stream,
    close: () =>
      Effect.sync(() => {
        client.destroy();
      }),
  };
};
