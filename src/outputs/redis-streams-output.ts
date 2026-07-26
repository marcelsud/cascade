/**
 * Redis Streams Output - Sends messages to Redis Streams
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
  openRedisOutputClient,
  recordRedisSendSuccess,
  redisConnectionSchemaFields,
  runRedisSendWithRetry,
  type RedisConnectionConfig,
} from "./redis-output-options.js";

export interface RedisStreamsOutputConfig extends RedisConnectionConfig {
  readonly stream: string;
  readonly maxLen?: number;
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
  ...redisHostEndpointSchemaFields,
  stream: NonEmptyString,
  maxLen: Schema.optional(PositiveInt),
  ...redisAuthSchemaFields,
  ...redisConnectionSchemaFields,
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

  const client = openRedisOutputClient(config, "Redis Streams output");
  const connectionInfo = formatRedisConnectionInfo(config);
  const metrics = new MetricsAccumulator("redis-streams-output");
  let messageCount = 0;
  let connectionLogged = false;

  return {
    name: "redis-streams-output",
    getMetrics: () => metrics.getOutputMetrics(),
    send: (msg: Message): Effect.Effect<void, RedisOutputError> => {
      return Effect.gen(function* () {
        // Log connection once per output lifecycle (INFO level)
        if (!connectionLogged) {
          connectionLogged = true;
          yield* Effect.logInfo(`Connected to Redis stream: ${connectionInfo}`);
        }

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
        const [_, duration] = yield* runRedisSendWithRetry(
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
          }),
          metrics,
          config.maxRetries ?? 3,
          `Redis send failed after ${config.maxRetries ?? 3} retries: `,
        );

        messageCount = yield* recordRedisSendSuccess(
          metrics,
          duration,
          messageCount,
        );

        // Log successful send (DEBUG level)
        yield* Effect.logDebug(
          `Sent message ${msg.id} to stream ${config.stream}`,
        );
      });
    },
    close: () =>
      Effect.suspend(() => closeRedisOutput(client, metrics, messageCount)),
  };
};
