/**
 * Redis Pub/Sub Input - Consumes messages from Redis Pub/Sub channels
 */
import { Effect, Stream } from "effect";
import * as Schema from "effect/Schema";
import Redis from "ioredis";
import type { Input, Message } from "../core/types.js";
import { createMessage } from "../core/types.js";
import {
  ComponentError,
  type ErrorCategory,
  detectCategory,
} from "../core/errors.js";
import { MetricsAccumulator, emitInputMetrics } from "../core/metrics.js";
import {
  validate,
  NonEmptyString,
  Hostname,
  Port,
  PositiveInt,
} from "../core/validation.js";
import {
  createInputQueue,
  offerInputQueue,
  recordQueueDrop,
  type OverflowPolicy,
} from "./input-queue.js";

export interface RedisPubSubInputConfig {
  readonly host: string;
  readonly port: number;
  readonly password?: string;
  readonly db?: number;

  // Subscription configuration (must provide channels OR patterns)
  readonly channels?: string[]; // Exact channel names (SUBSCRIBE)
  readonly patterns?: string[]; // Pattern matching (PSUBSCRIBE)

  // Connection configuration
  readonly connectTimeout?: number; // Connection timeout in ms (default: 10000)
  readonly commandTimeout?: number; // Command timeout in ms (default: undefined)
  readonly keepAlive?: number; // TCP keep-alive in ms (default: 30000)
  readonly lazyConnect?: boolean; // Defer connection until first command (default: false)
  readonly maxRetriesPerRequest?: number; // Max retries per request (default: 20)
  readonly enableOfflineQueue?: boolean; // Queue commands when offline (default: true)

  // Message queue configuration
  readonly queueSize?: number; // Max messages in memory queue (default: 1000)
  readonly overflow?: OverflowPolicy;
}

export class RedisPubSubInputError extends ComponentError {
  readonly _tag = "RedisPubSubInputError";

  constructor(
    message: string,
    readonly category: ErrorCategory,
    cause?: unknown,
  ) {
    super(message, cause);
  }
}

/**
 * Validation schema for Redis Pub/Sub Input configuration
 */
export const RedisPubSubInputConfigSchema = Schema.Struct({
  host: Schema.Union(Hostname, NonEmptyString),
  port: Port,
  password: Schema.optional(NonEmptyString),
  db: Schema.optional(Schema.Int.pipe(Schema.nonNegative())),
  channels: Schema.optional(
    Schema.Array(NonEmptyString).pipe(Schema.minItems(1)),
  ),
  patterns: Schema.optional(
    Schema.Array(NonEmptyString).pipe(Schema.minItems(1)),
  ),
  connectTimeout: Schema.optional(PositiveInt),
  commandTimeout: Schema.optional(PositiveInt),
  keepAlive: Schema.optional(PositiveInt),
  lazyConnect: Schema.optional(Schema.Boolean),
  maxRetriesPerRequest: Schema.optional(Schema.Int.pipe(Schema.nonNegative())),
  enableOfflineQueue: Schema.optional(Schema.Boolean),
  queueSize: Schema.optional(PositiveInt),
  overflow: Schema.optional(Schema.Literal("block", "drop_new", "drop_old")),
});

/**
 * Convert Redis Pub/Sub message to internal Message
 */
const convertPubSubMessage = (
  channel: string,
  message: string,
  pattern?: string,
): Effect.Effect<Message, RedisPubSubInputError> =>
  Effect.gen(function* () {
    // Parse content with graceful degradation
    let content: unknown;
    try {
      content = JSON.parse(message);
    } catch (error) {
      // Graceful degradation: use raw content if parse fails
      yield* Effect.logDebug(
        `Failed to parse message from channel ${channel}, using raw value: ${error instanceof Error ? error.message : String(error)}`,
      );
      content = { raw: message };
    }

    // Build metadata
    const metadata: Record<string, any> = {
      source: "redis-pubsub-input",
      channel: channel,
      receivedAt: new Date().toISOString(),
    };

    // Add pattern if this was from PSUBSCRIBE
    if (pattern) {
      metadata.pattern = pattern;
    }

    const msg = createMessage(content, metadata);
    return msg;
  });

/**
 * Create a Redis Pub/Sub input source
 */
export const createRedisPubSubInput = (
  config: RedisPubSubInputConfig,
): Input<RedisPubSubInputError> => {
  // Validate configuration synchronously at creation time
  Effect.runSync(
    validate(
      RedisPubSubInputConfigSchema,
      config,
      "Redis Pub/Sub Input configuration",
    ).pipe(
      Effect.catchAll((error) =>
        Effect.fail(
          new RedisPubSubInputError(error.message, error.category, error),
        ),
      ),
    ),
  );

  // Validate that at least one of channels or patterns is provided
  if (
    (!config.channels || config.channels.length === 0) &&
    (!config.patterns || config.patterns.length === 0)
  ) {
    throw new RedisPubSubInputError(
      "Redis Pub/Sub Input requires at least one channel or pattern",
      "fatal",
    );
  }

  // Create subscriber client (separate client for pub/sub)
  const subscriber = new Redis({
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

  const queueSize = config.queueSize ?? 1_000;
  const overflow = config.overflow ?? "block";
  const metrics = new MetricsAccumulator("redis-pubsub-input");
  const dropLogState = { lastLogAt: 0, suppressed: 0 };
  let messageCount = 0;

  // Create the stream using Queue for message buffering
  const stream = Stream.unwrap(
    Effect.gen(function* () {
      const queue = yield* createInputQueue<Message>(queueSize, overflow);

      // Set up message handler
      subscriber.on("message", (channel: string, message: string) => {
        const effect = Effect.gen(function* () {
          const startTime = Date.now();
          const msg = yield* convertPubSubMessage(channel, message);
          const duration = Date.now() - startTime;

          const offer = yield* offerInputQueue(queue, msg, overflow, queueSize);
          if (offer.accepted) {
            metrics.recordProcessed(duration);
            messageCount++;

            // Emit metrics every 100 messages
            if (messageCount >= 100) {
              yield* emitInputMetrics(metrics.getInputMetrics());
              messageCount = 0;
            }
          }
          if (offer.dropped > 0) {
            yield* recordQueueDrop(metrics, dropLogState, "Redis Pub/Sub");
          }
        });

        Effect.runPromise(effect).catch((error) => {
          console.error(`Error processing pub/sub message: ${error}`);
        });
      });

      // Set up pattern message handler (if using PSUBSCRIBE)
      subscriber.on(
        "pmessage",
        (pattern: string, channel: string, message: string) => {
          const effect = Effect.gen(function* () {
            const startTime = Date.now();
            const msg = yield* convertPubSubMessage(channel, message, pattern);
            const duration = Date.now() - startTime;

            const offer = yield* offerInputQueue(
              queue,
              msg,
              overflow,
              queueSize,
            );
            if (offer.accepted) {
              metrics.recordProcessed(duration);
              messageCount++;

              if (messageCount >= 100) {
                yield* emitInputMetrics(metrics.getInputMetrics());
                messageCount = 0;
              }
            }
            if (offer.dropped > 0) {
              yield* recordQueueDrop(metrics, dropLogState, "Redis Pub/Sub");
            }
          });

          Effect.runPromise(effect).catch((error) => {
            console.error(`Error processing pub/sub pattern message: ${error}`);
          });
        },
      );

      // Set up error handler
      subscriber.on("error", (error: Error) => {
        const effect = Effect.gen(function* () {
          metrics.recordError();
          yield* Effect.logError(
            `Redis Pub/Sub connection error: ${error.message}`,
          );
        });
        Effect.runPromise(effect);
      });

      // Subscribe to channels and patterns
      yield* Effect.tryPromise({
        try: async () => {
          if (config.channels && config.channels.length > 0) {
            await subscriber.subscribe(...config.channels);
            console.log(
              `Subscribed to channels: ${config.channels.join(", ")}`,
            );
          }
          if (config.patterns && config.patterns.length > 0) {
            await subscriber.psubscribe(...config.patterns);
            console.log(
              `Subscribed to patterns: ${config.patterns.join(", ")}`,
            );
          }
        },
        catch: (error) =>
          new RedisPubSubInputError(
            `Failed to subscribe to channels/patterns: ${error instanceof Error ? error.message : String(error)}`,
            detectCategory(error),
            error,
          ),
      });

      yield* Effect.logInfo(
        `Connected to Redis Pub/Sub: redis://${config.host}:${config.port}/${config.db || 0}`,
      );

      // Return stream that takes from queue
      return Stream.fromQueue(queue).pipe(
        Stream.catchAll((error) =>
          Stream.fromEffect(
            Effect.gen(function* () {
              metrics.recordError();
              yield* Effect.logError(
                `Redis Pub/Sub stream error: ${String(error)}`,
              );
              yield* Effect.sleep("5 seconds");
              // Return empty to continue stream
              return undefined as never;
            }),
          ),
        ),
      );
    }),
  );

  return {
    name: "redis-pubsub-input",
    getMetrics: () => metrics.getInputMetrics(),
    stream,
    close: () =>
      Effect.gen(function* () {
        yield* Effect.tryPromise({
          try: async () => {
            await subscriber.unsubscribe();
            await subscriber.punsubscribe();
            await subscriber.quit();
          },
          catch: (error) =>
            new RedisPubSubInputError(
              `Failed to close Redis Pub/Sub connection: ${error instanceof Error ? error.message : String(error)}`,
              detectCategory(error),
              error,
            ),
        }).pipe(
          Effect.catchAll((error) => {
            // Log but don't fail on close (best effort cleanup)
            console.error("Failed to close Redis Pub/Sub connection:", error);
            return Effect.void;
          }),
        );
      }),
  };
};
