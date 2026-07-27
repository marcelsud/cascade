/**
 * Shared helpers for Redis output components.
 * Keeps connection option defaults, template interpolation, payload
 * serialization, and close/metrics cadence identical across list, pubsub,
 * and streams outputs.
 */
import { Effect, Schedule } from "effect";
import type Redis from "ioredis";
import type { Message } from "../core/types.js";
import { closeRedisClient } from "../core/redis-client.js";
import {
  openConfiguredRedisClient,
  type RedisClientConnectionOptions,
} from "../core/redis-client-options.js";
import {
  emitOutputMetrics,
  measureDuration,
  type MetricsAccumulator,
} from "../core/metrics.js";
import { RetryCount } from "../core/validation.js";
import * as Schema from "effect/Schema";
import { redisClientSchemaFields } from "../core/redis-connection-schema.js";

/**
 * Connection-related fields shared by every Redis output config.
 */
export type RedisConnectionConfig = RedisClientConnectionOptions & {
  readonly maxRetries?: number;
};

/**
 * Schema fields shared by Redis output component config schemas after the
 * resource-specific fields (key/channel/stream) and auth fields.
 * Spread into each component's Schema.Struct at the original position.
 */
export const redisConnectionSchemaFields = {
  maxRetries: Schema.optional(RetryCount),
  ...redisClientSchemaFields,
} as const;

/**
 * Create a Redis client and attach the standard error observer.
 */
export const openRedisOutputClient = (
  config: RedisConnectionConfig,
  componentLabel: string,
): Redis => openConfiguredRedisClient(config, componentLabel);

/**
 * Interpolate a `{{path.to.value}}` template against a Message.
 * Missing or null paths resolve to an empty string; leaves are String()'d.
 * Used for Redis list keys and pub/sub channels.
 *
 * Uses optional property access so primitive intermediates still resolve
 * (e.g. `{{content.name.length}}` on a string name).
 */
export const interpolateMessageTemplate = (
  template: string,
  msg: Message,
): string => {
  return template.replace(/\{\{([^}]+)\}\}/g, (_, path) => {
    const parts = path.trim().split(".");
    // Optional chaining on unknown values matches the pre-extraction semantics.
    let value: unknown = msg;

    for (const part of parts) {
      value = (value as { [key: string]: unknown } | null | undefined)?.[part];
      if (value === undefined || value === null) {
        return "";
      }
    }

    return String(value);
  });
};

/**
 * Serialize the full message envelope used by list and pub/sub outputs.
 */
export const serializeRedisMessagePayload = (msg: Message): string =>
  JSON.stringify({
    id: msg.id,
    correlationId: msg.correlationId,
    timestamp: msg.timestamp,
    content: msg.content,
    metadata: msg.metadata,
    trace: msg.trace,
  });

/**
 * Retry policy shared by every retried Redis command: bounded attempts with
 * exponential backoff starting at one second.
 */
export const redisRetryPolicy = (maxRetries: number) => ({
  times: maxRetries,
  schedule: Schedule.exponential("1 second"),
});

/**
 * Run a Redis send promise with the shared retry / metrics / error-log policy.
 */
export const runRedisSendWithRetry = <
  A,
  E extends { readonly message: string },
>(
  operation: Effect.Effect<A, E>,
  metrics: MetricsAccumulator,
  maxRetries: number,
  failureLogPrefix: string,
): Effect.Effect<readonly [A, number], E> =>
  measureDuration(
    operation.pipe(
      Effect.retry(redisRetryPolicy(maxRetries)),
      Effect.tapError((error) => {
        metrics.recordSendError();
        return Effect.logError(`${failureLogPrefix}${error.message}`);
      }),
    ),
  );

/**
 * Record a successful send and emit metrics every 100 messages.
 * Returns the updated message count counter.
 */
export const recordRedisSendSuccess = (
  metrics: MetricsAccumulator,
  duration: number,
  messageCount: number,
): Effect.Effect<number> =>
  Effect.gen(function* () {
    metrics.recordSent(1, duration);
    const next = messageCount + 1;
    if (next >= 100) {
      yield* emitOutputMetrics(metrics.getOutputMetrics());
      return 0;
    }
    return next;
  });

/**
 * Shared close path: flush remaining metrics, then close the client best-effort.
 */
export const closeRedisOutput = (
  client: Redis,
  metrics: MetricsAccumulator,
  messageCount: number,
): Effect.Effect<void> =>
  Effect.gen(function* () {
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
  });
