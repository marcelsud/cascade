/**
 * Redis Streams Output - Sends messages to Redis Streams
 */
import { Effect, Schedule } from "effect";
import * as Schema from "effect/Schema";
import Redis from "ioredis";
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
  Hostname,
  Port,
  PositiveInt,
  RetryCount,
} from "../core/validation.js";
import {
  closeRedisClient,
  observeRedisClientErrors,
} from "../core/redis-client.js";
import { redisOutputOptions } from "./redis-output-options.js";

export interface RedisStreamsOutputConfig {
  readonly host: string;
  readonly port: number;
  readonly stream: string;
  readonly maxLen?: number;
  readonly password?: string;
  readonly db?: number;
  readonly maxRetries?: number; // Added for retry configuration

  // Connection pooling configuration
  readonly connectTimeout?: number; // Connection timeout in ms (default: 10000)
  readonly commandTimeout?: number; // Command timeout in ms (default: undefined)
  readonly keepAlive?: number; // TCP keep-alive in ms (default: 30000)
  readonly lazyConnect?: boolean; // Defer connection until first command (default: false)
  readonly maxRetriesPerRequest?: number; // Max retries per request (default: 20)
  readonly enableOfflineQueue?: boolean; // Queue commands when offline (default: false)
}

export class RedisOutputError extends ComponentError {
  readonly _tag = "RedisOutputError";

  constructor(
    message: string,
    readonly category: ErrorCategory,
    cause?: unknown,
  ) {
    super(message, cause);
  }
}

/**
 * Validation schema for Redis Streams Output configuration
 */
export const RedisStreamsOutputConfigSchema = Schema.Struct({
  host: Schema.Union(Hostname, NonEmptyString),
  port: Port,
  stream: NonEmptyString,
  maxLen: Schema.optional(PositiveInt),
  password: Schema.optional(NonEmptyString),
  db: Schema.optional(Schema.Int.pipe(Schema.nonNegative())),
  maxRetries: Schema.optional(RetryCount),
  connectTimeout: Schema.optional(PositiveInt),
  commandTimeout: Schema.optional(PositiveInt),
  keepAlive: Schema.optional(PositiveInt),
  lazyConnect: Schema.optional(Schema.Boolean),
  maxRetriesPerRequest: Schema.optional(Schema.Int.pipe(Schema.nonNegative())),
  enableOfflineQueue: Schema.optional(Schema.Boolean),
});

/**
 * Create a Redis Streams output
 */
export const createRedisStreamsOutput = (
  config: RedisStreamsOutputConfig,
): Output<RedisOutputError> => {
  // Validate configuration synchronously at creation time
  Effect.runSync(
    validate(
      RedisStreamsOutputConfigSchema,
      config,
      "Redis Streams Output configuration",
    ).pipe(
      Effect.catchAll((error) =>
        Effect.fail(new RedisOutputError(error.message, error.category, error)),
      ),
    ),
  );

  const client = new Redis(redisOutputOptions(config));
  observeRedisClientErrors(client, "Redis Streams output");

  // Log connection info
  const connectionInfo = `redis://${config.host}:${config.port}/${config.db || 0}`;

  // Metrics tracking
  const metrics = new MetricsAccumulator("redis-streams-output");
  let messageCount = 0;

  return {
    name: "redis-streams-output",
    getMetrics: () => metrics.getOutputMetrics(),
    send: (msg: Message): Effect.Effect<void, RedisOutputError> => {
      return Effect.gen(function* () {
        // Log connection on first send (INFO level)
        yield* Effect.logInfo(`Connected to Redis stream: ${connectionInfo}`);

        // Prepare fields for XADD with trace context
        const fields: Record<string, string> = {
          id: msg.id,
          correlationId: msg.correlationId || "",
          timestamp: msg.timestamp.toString(),
          content: JSON.stringify(msg.content),
          metadata: JSON.stringify(msg.metadata),
          // Preserve trace context
          trace: msg.trace ? JSON.stringify(msg.trace) : "",
        };

        // Send with retry logic
        const [_, duration] = yield* measureDuration(
          Effect.tryPromise({
            try: async () => {
              // Use XADD command
              if (config.maxLen) {
                await client.xadd(
                  config.stream,
                  "MAXLEN",
                  "~",
                  config.maxLen,
                  "*",
                  ...Object.entries(fields).flat(),
                );
              } else {
                await client.xadd(
                  config.stream,
                  "*",
                  ...Object.entries(fields).flat(),
                );
              }
            },
            catch: (error) =>
              new RedisOutputError(
                `Failed to send message to Redis stream ${config.stream}: ${error instanceof Error ? error.message : String(error)}`,
                detectCategory(error),
                error,
              ),
          }).pipe(
            // Retry with exponential backoff
            Effect.retry({
              times: config.maxRetries ?? 3,
              schedule: Schedule.exponential("1 second"),
            }),
            Effect.tapError((error) => {
              metrics.recordSendError();
              return Effect.logError(
                `Redis send failed after ${config.maxRetries ?? 3} retries: ${error.message}`,
              );
            }),
          ),
        );

        // Record successful send
        metrics.recordSent(1, duration);
        messageCount++;

        // Emit metrics every 100 messages
        if (messageCount >= 100) {
          yield* emitOutputMetrics(metrics.getOutputMetrics());
          messageCount = 0;
        }

        // Log successful send (DEBUG level)
        yield* Effect.logDebug(
          `Sent message ${msg.id} to stream ${config.stream}`,
        );
      });
    },
    close: () =>
      Effect.gen(function* () {
        // Emit final metrics
        if (messageCount > 0) {
          yield* emitOutputMetrics(metrics.getOutputMetrics());
        }
        yield* Effect.tryPromise({
          try: async () => {
            await closeRedisClient(client);
          },
          catch: (error) => {
            // Log but don't fail on close (best effort cleanup)
            console.error("Failed to close Redis connection:", error);
            return undefined;
          },
        }).pipe(
          Effect.catchAll(() => Effect.void), // Never fail on close
        );
      }),
  };
};
