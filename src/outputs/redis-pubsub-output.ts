/**
 * Redis Pub/Sub Output - Publishes messages to Redis Pub/Sub channels
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

export interface RedisPubSubOutputConfig {
  readonly host: string;
  readonly port: number;
  readonly channel: string; // Can use template interpolation like "events:{{content.type}}"
  readonly password?: string;
  readonly db?: number;
  readonly maxRetries?: number; // Retry configuration (default: 3)

  // Connection configuration
  readonly connectTimeout?: number; // Connection timeout in ms (default: 10000)
  readonly commandTimeout?: number; // Command timeout in ms (default: undefined)
  readonly keepAlive?: number; // TCP keep-alive in ms (default: 30000)
  readonly lazyConnect?: boolean; // Defer connection until first command (default: false)
  readonly maxRetriesPerRequest?: number; // Max retries per request (default: 20)
  readonly enableOfflineQueue?: boolean; // Queue commands when offline (default: true)
}

export class RedisPubSubOutputError extends ComponentError {
  readonly _tag = "RedisPubSubOutputError";

  constructor(
    message: string,
    readonly category: ErrorCategory,
    cause?: unknown,
  ) {
    super(message, cause);
  }
}

/**
 * Validation schema for Redis Pub/Sub Output configuration
 */
export const RedisPubSubOutputConfigSchema = Schema.Struct({
  host: Schema.Union(Hostname, NonEmptyString),
  port: Port,
  channel: NonEmptyString,
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
 * Interpolate channel template with message data
 * Supports templates like "events:{{content.type}}" or "user:{{metadata.userId}}"
 */
const interpolateChannel = (template: string, msg: Message): string => {
  return template.replace(/\{\{([^}]+)\}\}/g, (_, path) => {
    const parts = path.trim().split(".");
    let value: any = msg;

    for (const part of parts) {
      value = value?.[part];
      if (value === undefined || value === null) {
        return "";
      }
    }

    return String(value);
  });
};

/**
 * Create a Redis Pub/Sub output
 */
export const createRedisPubSubOutput = (
  config: RedisPubSubOutputConfig,
): Output<RedisPubSubOutputError> => {
  // Validate configuration synchronously at creation time
  Effect.runSync(
    validate(
      RedisPubSubOutputConfigSchema,
      config,
      "Redis Pub/Sub Output configuration",
    ).pipe(
      Effect.catchAll((error) =>
        Effect.fail(
          new RedisPubSubOutputError(error.message, error.category, error),
        ),
      ),
    ),
  );

  const client = new Redis({
    host: config.host,
    port: config.port,
    password: config.password,
    db: config.db || 0,
    connectTimeout: config.connectTimeout ?? 10000,
    commandTimeout: config.commandTimeout,
    keepAlive: config.keepAlive ?? 30000,
    lazyConnect: config.lazyConnect ?? false,
    maxRetriesPerRequest: config.maxRetriesPerRequest ?? 20,
    enableOfflineQueue: config.enableOfflineQueue ?? true,
    retryStrategy: (times) => {
      const delay = Math.min(times * 50, 2000);
      return delay;
    },
  });
  observeRedisClientErrors(client, "Redis Pub/Sub output");

  // Log connection info
  const connectionInfo = `redis://${config.host}:${config.port}/${config.db || 0}`;

  // Metrics tracking
  const metrics = new MetricsAccumulator("redis-pubsub-output");
  let messageCount = 0;

  return {
    name: "redis-pubsub-output",
    getMetrics: () => metrics.getOutputMetrics(),
    send: (msg: Message): Effect.Effect<void, RedisPubSubOutputError> => {
      return Effect.gen(function* () {
        // Log connection on first send (INFO level)
        yield* Effect.logInfo(`Connected to Redis Pub/Sub: ${connectionInfo}`);

        // Interpolate channel name with message data
        const channel = interpolateChannel(config.channel, msg);

        // Prepare message payload (serialize entire message as JSON)
        const payload = JSON.stringify({
          id: msg.id,
          correlationId: msg.correlationId,
          timestamp: msg.timestamp,
          content: msg.content,
          metadata: msg.metadata,
          trace: msg.trace,
        });

        // Publish with retry logic
        const [numSubscribers, duration] = yield* measureDuration(
          Effect.tryPromise({
            try: async () => {
              // PUBLISH returns number of subscribers that received the message
              return await client.publish(channel, payload);
            },
            catch: (error) =>
              new RedisPubSubOutputError(
                `Failed to publish message to channel ${channel}: ${error instanceof Error ? error.message : String(error)}`,
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
                `Redis publish failed after ${config.maxRetries ?? 3} retries: ${error.message}`,
              );
            }),
          ),
        );

        // Log warning if no subscribers received the message
        if (numSubscribers === 0) {
          yield* Effect.logWarning(
            `Published message ${msg.id} to channel ${channel} but no subscribers were listening`,
          );
        }

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
          `Published message ${msg.id} to channel ${channel} (${numSubscribers} subscribers)`,
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
