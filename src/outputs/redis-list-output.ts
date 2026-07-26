/**
 * Redis List Output - Pushes messages to Redis Lists
 */
import { Effect } from "effect";
import * as Schema from "effect/Schema";
import type { Output, Message } from "../core/types.js";
import {
  ComponentError,
  type ErrorCategory,
  detectCategory,
} from "../core/errors.js";
import { MetricsAccumulator } from "../core/metrics.js";
import { validate, NonEmptyString, PositiveInt } from "../core/validation.js";
import { formatRedisConnectionInfo } from "../core/redis-client-options.js";
import {
  redisAuthSchemaFields,
  redisHostEndpointSchemaFields,
} from "../core/redis-connection-schema.js";
import {
  closeRedisOutput,
  interpolateMessageTemplate,
  openRedisOutputClient,
  recordRedisSendSuccess,
  redisConnectionSchemaFields,
  runRedisSendWithRetry,
  serializeRedisMessagePayload,
  type RedisConnectionConfig,
} from "./redis-output-options.js";

export interface RedisListOutputConfig extends RedisConnectionConfig {
  readonly key: string; // List key (can use template interpolation)

  // Push configuration
  readonly direction?: "left" | "right"; // LPUSH (left) or RPUSH (right) (default: "right")
  readonly maxLen?: number; // Optional max length (uses LTRIM to cap list size)
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
  ...redisHostEndpointSchemaFields,
  key: NonEmptyString,
  ...redisAuthSchemaFields,
  direction: Schema.optional(Schema.Literal("left", "right")),
  maxLen: Schema.optional(PositiveInt),
  ...redisConnectionSchemaFields,
});

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

  const client = openRedisOutputClient(config, "Redis List output");
  const direction = config.direction ?? "right";
  const connectionInfo = formatRedisConnectionInfo(config);
  const metrics = new MetricsAccumulator("redis-list-output");
  let messageCount = 0;
  let connectionLogged = false;

  return {
    name: "redis-list-output",
    getMetrics: () => metrics.getOutputMetrics(),
    send: (msg: Message): Effect.Effect<void, RedisListOutputError> => {
      return Effect.gen(function* () {
        // Log connection once per output lifecycle (INFO level)
        if (!connectionLogged) {
          connectionLogged = true;
          yield* Effect.logInfo(`Connected to Redis: ${connectionInfo}`);
        }

        // Interpolate key name with message data
        const key = interpolateMessageTemplate(config.key, msg);
        const payload = serializeRedisMessagePayload(msg);

        // Push with retry logic
        const [listLength, duration] = yield* runRedisSendWithRetry(
          Effect.tryPromise({
            try: async () => {
              // Push to list
              let length: number;
              if (direction === "left") {
                length = await client.lpush(key, payload);
              } else {
                length = await client.rpush(key, payload);
              }

              // Trim list if maxLen is configured, keeping the newest entries
              // for the producer direction:
              // - RPUSH (right): oldest→newest; keep the tail via LTRIM -N -1
              // - LPUSH (left): newest→oldest; keep the head via LTRIM 0 N-1
              if (config.maxLen && length > config.maxLen) {
                if (direction === "left") {
                  await client.ltrim(key, 0, config.maxLen - 1);
                } else {
                  await client.ltrim(key, -config.maxLen, -1);
                }
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
          }),
          metrics,
          config.maxRetries ?? 3,
          `Redis push failed after ${config.maxRetries ?? 3} retries: `,
        );

        messageCount = yield* recordRedisSendSuccess(
          metrics,
          duration,
          messageCount,
        );

        // Log successful send (DEBUG level)
        yield* Effect.logDebug(
          `Pushed message ${msg.id} to ${direction} of list ${key} (length: ${listLength})`,
        );
      });
    },
    close: () =>
      Effect.suspend(() => closeRedisOutput(client, metrics, messageCount)),
  };
};
