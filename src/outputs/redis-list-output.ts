/**
 * Redis List Output - Pushes messages to Redis Lists
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

export interface RedisListOutputConfig {
  readonly host: string;
  readonly port: number;
  readonly key: string; // List key (can use template interpolation)
  readonly password?: string;
  readonly db?: number;

  // Push configuration
  readonly direction?: "left" | "right"; // LPUSH (left) or RPUSH (right) (default: "right")
  readonly maxLen?: number; // Optional max length (uses LTRIM to cap list size)
  readonly maxRetries?: number; // Retry configuration (default: 3)

  // Connection configuration
  readonly connectTimeout?: number; // Connection timeout in ms (default: 10000)
  readonly commandTimeout?: number; // Command timeout in ms (default: undefined)
  readonly keepAlive?: number; // TCP keep-alive in ms (default: 30000)
  readonly lazyConnect?: boolean; // Defer connection until first command (default: false)
  readonly maxRetriesPerRequest?: number; // Max retries per request (default: 20)
  readonly enableOfflineQueue?: boolean; // Queue commands when offline (default: true)
}

export class RedisListOutputError extends ComponentError {
  readonly _tag = "RedisListOutputError";

  constructor(
    message: string,
    readonly category: ErrorCategory,
    cause?: unknown,
  ) {
    super(message, cause);
  }
}

/**
 * Validation schema for Redis List Output configuration
 */
export const RedisListOutputConfigSchema = Schema.Struct({
  host: Schema.Union(Hostname, NonEmptyString),
  port: Port,
  key: NonEmptyString,
  password: Schema.optional(NonEmptyString),
  db: Schema.optional(Schema.Int.pipe(Schema.nonNegative())),
  direction: Schema.optional(Schema.Literal("left", "right")),
  maxLen: Schema.optional(PositiveInt),
  maxRetries: Schema.optional(RetryCount),
  connectTimeout: Schema.optional(PositiveInt),
  commandTimeout: Schema.optional(PositiveInt),
  keepAlive: Schema.optional(PositiveInt),
  lazyConnect: Schema.optional(Schema.Boolean),
  maxRetriesPerRequest: Schema.optional(Schema.Int.pipe(Schema.nonNegative())),
  enableOfflineQueue: Schema.optional(Schema.Boolean),
});

/**
 * Interpolate key template with message data
 * Supports templates like "queue:{{content.type}}" or "tasks:{{metadata.priority}}"
 */
const interpolateKey = (template: string, msg: Message): string => {
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
 * Create a Redis List output
 */
export const createRedisListOutput = (
  config: RedisListOutputConfig,
): Output<RedisListOutputError> => {
  // Validate configuration synchronously at creation time
  Effect.runSync(
    validate(
      RedisListOutputConfigSchema,
      config,
      "Redis List Output configuration",
    ).pipe(
      Effect.catchAll((error) =>
        Effect.fail(
          new RedisListOutputError(error.message, error.category, error),
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
  observeRedisClientErrors(client, "Redis List output");

  const direction = config.direction ?? "right";

  // Log connection info
  const connectionInfo = `redis://${config.host}:${config.port}/${config.db || 0}`;

  // Metrics tracking
  const metrics = new MetricsAccumulator("redis-list-output");
  let messageCount = 0;

  return {
    name: "redis-list-output",
    getMetrics: () => metrics.getOutputMetrics(),
    send: (msg: Message): Effect.Effect<void, RedisListOutputError> => {
      return Effect.gen(function* () {
        // Log connection on first send (INFO level)
        yield* Effect.logInfo(`Connected to Redis: ${connectionInfo}`);

        // Interpolate key name with message data
        const key = interpolateKey(config.key, msg);

        // Prepare message payload (serialize entire message as JSON)
        const payload = JSON.stringify({
          id: msg.id,
          correlationId: msg.correlationId,
          timestamp: msg.timestamp,
          content: msg.content,
          metadata: msg.metadata,
          trace: msg.trace,
        });

        // Push with retry logic
        const [listLength, duration] = yield* measureDuration(
          Effect.tryPromise({
            try: async () => {
              // Push to list
              let length: number;
              if (direction === "left") {
                length = await client.lpush(key, payload);
              } else {
                length = await client.rpush(key, payload);
              }

              // Trim list if maxLen is configured
              if (config.maxLen && length > config.maxLen) {
                await client.ltrim(key, 0, config.maxLen - 1);
                return config.maxLen;
              }

              return length;
            },
            catch: (error) =>
              new RedisListOutputError(
                `Failed to push message to Redis list ${key}: ${error instanceof Error ? error.message : String(error)}`,
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
                `Redis push failed after ${config.maxRetries ?? 3} retries: ${error.message}`,
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
          `Pushed message ${msg.id} to ${direction} of list ${key} (length: ${listLength})`,
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
