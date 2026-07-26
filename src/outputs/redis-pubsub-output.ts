/**
 * Redis Pub/Sub Output - Publishes messages to Redis Pub/Sub channels
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
import { validate, NonEmptyString } from "../core/validation.js";
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

export interface RedisPubSubOutputConfig extends RedisConnectionConfig {
  readonly channel: string; // Can use template interpolation like "events:{{content.type}}"
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
  ...redisHostEndpointSchemaFields,
  channel: NonEmptyString,
  ...redisAuthSchemaFields,
  ...redisConnectionSchemaFields,
});

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

  const client = openRedisOutputClient(config, "Redis Pub/Sub output");
  const connectionInfo = formatRedisConnectionInfo(config);
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
        const channel = interpolateMessageTemplate(config.channel, msg);
        const payload = serializeRedisMessagePayload(msg);

        // Publish with retry logic
        const [numSubscribers, duration] = yield* runRedisSendWithRetry(
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
          }),
          metrics,
          config.maxRetries ?? 3,
          `Redis publish failed after ${config.maxRetries ?? 3} retries: `,
        );

        // Log warning if no subscribers received the message
        if (numSubscribers === 0) {
          yield* Effect.logWarning(
            `Published message ${msg.id} to channel ${channel} but no subscribers were listening`,
          );
        }

        messageCount = yield* recordRedisSendSuccess(
          metrics,
          duration,
          messageCount,
        );

        // Log successful send (DEBUG level)
        yield* Effect.logDebug(
          `Published message ${msg.id} to channel ${channel} (${numSubscribers} subscribers)`,
        );
      });
    },
    close: () =>
      Effect.suspend(() => closeRedisOutput(client, metrics, messageCount)),
  };
};
