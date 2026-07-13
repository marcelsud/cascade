/**
 * Redis Streams Input - Consumes messages from Redis Streams
 */
import { Effect, Stream, Ref } from "effect";
import * as Schema from "effect/Schema";
import Redis from "ioredis";
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
  Hostname,
  Port,
  PositiveInt,
} from "../core/validation.js";

export interface RedisStreamsInputConfig {
  readonly host: string;
  readonly port: number;
  readonly stream: string;
  readonly password?: string;
  readonly db?: number;

  // Mode configuration
  readonly mode?: "simple" | "consumer-group";
  readonly consumerGroup?: string;
  readonly consumerName?: string;

  // Read configuration
  readonly blockMs?: number; // Blocking timeout (default 5000)
  readonly count?: number; // Messages per read (default 10)
  readonly startId?: string; // Starting position: "0", "$", or specific ID (default "$")

  // Connection pooling configuration
  readonly connectTimeout?: number; // Connection timeout in ms (default: 10000)
  readonly commandTimeout?: number; // Command timeout in ms (default: undefined)
  readonly keepAlive?: number; // TCP keep-alive in ms (default: 30000)
  readonly lazyConnect?: boolean; // Defer connection until first command (default: false)
  readonly maxRetriesPerRequest?: number; // Max retries per request (default: 20)
  readonly enableOfflineQueue?: boolean; // Queue commands when offline (default: true)
}

export class RedisStreamsInputError extends ComponentError {
  readonly _tag = "RedisStreamsInputError";

  constructor(
    message: string,
    readonly category: ErrorCategory,
    cause?: unknown,
  ) {
    super(message, cause);
  }
}

/**
 * Validation schema for Redis Streams Input configuration
 */
export const RedisStreamsInputConfigSchema = Schema.Struct({
  host: Schema.Union(Hostname, NonEmptyString),
  port: Port,
  stream: NonEmptyString,
  password: Schema.optional(NonEmptyString),
  db: Schema.optional(Schema.Int.pipe(Schema.nonNegative())),
  mode: Schema.optional(Schema.Literal("simple", "consumer-group")),
  consumerGroup: Schema.optional(NonEmptyString),
  consumerName: Schema.optional(NonEmptyString),
  blockMs: Schema.optional(Schema.Int.pipe(Schema.nonNegative())),
  count: Schema.optional(PositiveInt),
  startId: Schema.optional(NonEmptyString),
  connectTimeout: Schema.optional(PositiveInt),
  commandTimeout: Schema.optional(PositiveInt),
  keepAlive: Schema.optional(PositiveInt),
  lazyConnect: Schema.optional(Schema.Boolean),
  maxRetriesPerRequest: Schema.optional(Schema.Int.pipe(Schema.nonNegative())),
  enableOfflineQueue: Schema.optional(Schema.Boolean),
});

/**
 * Convert Redis stream entry to internal Message
 */
const convertRedisEntry = (
  streamName: string,
  entry: [string, string[]],
): Effect.Effect<Message, RedisStreamsInputError> =>
  Effect.gen(function* () {
    const [entryId, fields] = entry;

    // Parse fields (Redis returns flat array: [key, value, key, value, ...])
    const parsed: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) {
      parsed[fields[i]] = fields[i + 1];
    }

    // Parse content with graceful degradation
    let content: unknown;
    try {
      content = JSON.parse(parsed.content || "{}");
    } catch (error) {
      // Graceful degradation: use raw content if parse fails
      yield* Effect.logError(
        `Failed to parse content for entry ${entryId}, using raw value: ${error instanceof Error ? error.message : String(error)}`,
      );
      content = { raw: parsed.content };
    }

    // Parse metadata with graceful degradation
    let metadata: Record<string, any>;
    try {
      metadata = JSON.parse(parsed.metadata || "{}");
    } catch (error) {
      yield* Effect.logError(
        `Failed to parse metadata for entry ${entryId}, using empty object: ${error instanceof Error ? error.message : String(error)}`,
      );
      metadata = {};
    }

    // Add metadata enrichment
    metadata = {
      ...metadata,
      source: "redis-streams-input",
      externalId: entryId,
      receivedAt: new Date().toISOString(),
      streamName: streamName,
    };

    const msg = createMessage(content, metadata);

    // Set optional fields
    if (parsed.correlationId) {
      (msg as any).correlationId = parsed.correlationId;
    }
    if (parsed.timestamp) {
      (msg as any).timestamp = parseInt(parsed.timestamp);
    }

    return msg;
  });

/**
 * Create a Redis Streams input source
 */
export const createRedisStreamsInput = (
  config: RedisStreamsInputConfig,
): Input<RedisStreamsInputError> => {
  // Validate configuration synchronously at creation time
  Effect.runSync(
    validate(
      RedisStreamsInputConfigSchema,
      config,
      "Redis Streams Input configuration",
    ).pipe(
      Effect.catchAll((error) =>
        Effect.fail(
          new RedisStreamsInputError(error.message, error.category, error),
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

  const mode =
    config.mode ?? (config.consumerGroup ? "consumer-group" : "simple");
  const blockMs = config.blockMs ?? 5000;
  const count = config.count ?? 10;
  const startId = config.startId ?? "$";

  /**
   * Simple XREAD mode (no consumer group)
   */
  if (mode === "simple") {
    // Use Ref for immutable state management
    const lastIdRef = Ref.unsafeMake(startId);
    const metrics = new MetricsAccumulator("redis-streams-input");
    let messageCount = 0;

    const stream = Stream.repeatEffect(
      Effect.gen(function* () {
        const lastId = yield* Ref.get(lastIdRef);

        yield* Effect.logInfo(
          `Connected to Redis stream: redis://${config.host}:${config.port}/${config.db || 0}`,
        );
        yield* Effect.logDebug(
          `Polling Redis stream ${config.stream} from ${lastId}`,
        );

        const [results, readDuration] = yield* measureDuration(
          Effect.tryPromise({
            try: async () =>
              await client.xread(
                "COUNT",
                count,
                "BLOCK",
                blockMs,
                "STREAMS",
                config.stream,
                lastId === "$" ? "$" : lastId,
              ),
            catch: (error) =>
              new RedisStreamsInputError(
                `Failed to read from Redis stream: ${error instanceof Error ? error.message : String(error)}`,
                detectCategory(error),
                error,
              ),
          }),
        );

        // No new messages
        if (!results || results.length === 0) {
          return [];
        }

        // Process results
        const [streamName, entries] = results[0];
        const messages = yield* Effect.forEach(
          entries as [string, string[]][],
          (entry) =>
            Effect.gen(function* () {
              const [entryId] = entry;
              // Update last ID for next poll (immutably)
              yield* Ref.set(lastIdRef, entryId);
              return yield* convertRedisEntry(streamName, entry);
            }),
          { concurrency: 5 },
        );

        // Record metrics
        messages.forEach(() => {
          metrics.recordProcessed(readDuration / messages.length);
          messageCount++;
        });

        // Emit metrics every 100 messages
        if (messageCount >= 100) {
          yield* emitInputMetrics(metrics.getInputMetrics());
          messageCount = 0;
        }

        yield* Effect.logDebug(
          `Read ${messages.length} messages from Redis stream`,
        );
        return messages;
      }),
    ).pipe(
      Stream.flatMap(Stream.fromIterable),
      Stream.catchAll((error) =>
        Stream.fromEffect(
          Effect.gen(function* () {
            metrics.recordError();
            yield* Effect.logError(`Redis stream error: ${error.message}`);
            yield* Effect.sleep("5 seconds");
            return [] as Message[];
          }),
        ).pipe(Stream.flatMap(Stream.fromIterable)),
      ),
    );

    return {
      name: "redis-streams-input",
      getMetrics: () => metrics.getInputMetrics(),
      stream,
      close: () => Effect.promise(() => client.quit()),
    };
  }

  /**
   * Consumer Group XREADGROUP mode
   */
  const consumerGroup = config.consumerGroup!;
  const consumerName =
    config.consumerName || "consumer-" + Math.random().toString(36).slice(2);
  const metrics = new MetricsAccumulator("redis-streams-input");
  let messageCount = 0;

  // Initialize consumer group
  const initConsumerGroup = Effect.tryPromise({
    try: async () => {
      try {
        // Try to create consumer group
        await client.xgroup(
          "CREATE",
          config.stream,
          consumerGroup,
          startId === "$" ? "$" : "0",
          "MKSTREAM",
        );
        return true;
      } catch (error: any) {
        // Group already exists - that's okay
        if (error.message && error.message.includes("BUSYGROUP")) {
          return true;
        }
        throw error;
      }
    },
    catch: (error) =>
      new RedisStreamsInputError(
        `Failed to initialize consumer group: ${error instanceof Error ? error.message : String(error)}`,
        detectCategory(error),
        error,
      ),
  });

  const ackMessage = (
    entryId: string,
  ): Effect.Effect<void, RedisStreamsInputError> =>
    Effect.tryPromise({
      try: async () => {
        await client.xack(config.stream, consumerGroup, entryId);
      },
      catch: (error) =>
        new RedisStreamsInputError(
          `Failed to ACK message ${entryId}`,
          detectCategory(error),
          error,
        ),
    });

  const stream = Stream.repeatEffect(
    Effect.gen(function* () {
      // Ensure consumer group exists
      yield* initConsumerGroup;

      yield* Effect.logInfo(
        `Connected to Redis stream: redis://${config.host}:${config.port}/${config.db || 0}`,
      );
      yield* Effect.logDebug(
        `Polling Redis stream ${config.stream} as ${consumerGroup}/${consumerName}`,
      );

      const [results, readDuration] = yield* measureDuration(
        Effect.tryPromise({
          try: async () =>
            await client.xreadgroup(
              "GROUP",
              consumerGroup,
              consumerName,
              "COUNT",
              count,
              "BLOCK",
              blockMs,
              "STREAMS",
              config.stream,
              ">", // Only new messages
            ),
          catch: (error) =>
            new RedisStreamsInputError(
              `Failed to read from consumer group: ${error instanceof Error ? error.message : String(error)}`,
              detectCategory(error),
              error,
            ),
        }),
      );

      // No new messages
      if (!results || results.length === 0) {
        return [];
      }

      // Process and ACK messages
      const [streamName, entries] = results[0] as [
        string,
        [string, string[]][],
      ];
      const messages = yield* Effect.forEach(
        entries as [string, string[]][],
        (entry) =>
          Effect.gen(function* () {
            const [entryId] = entry;
            const msg = yield* convertRedisEntry(streamName, entry);
            yield* ackMessage(entryId).pipe(
              Effect.catchAll((error) => {
                metrics.recordError();
                return Effect.logError(
                  `Failed to ACK ${entryId}: ${error.message}`,
                );
              }),
            );
            return msg;
          }),
        { concurrency: 5 },
      );

      // Record metrics
      messages.forEach(() => {
        metrics.recordProcessed(readDuration / messages.length);
        messageCount++;
      });

      // Emit metrics every 100 messages
      if (messageCount >= 100) {
        yield* emitInputMetrics(metrics.getInputMetrics());
        messageCount = 0;
      }

      yield* Effect.logDebug(
        `Read and ACKed ${messages.length} messages from Redis stream`,
      );
      return messages;
    }),
  ).pipe(
    Stream.flatMap(Stream.fromIterable),
    Stream.catchAll((error) =>
      Stream.fromEffect(
        Effect.gen(function* () {
          metrics.recordError();
          yield* Effect.logError(`Redis stream error: ${error.message}`);
          yield* Effect.sleep("5 seconds");
          return [] as Message[];
        }),
      ).pipe(Stream.flatMap(Stream.fromIterable)),
    ),
  );

  return {
    name: "redis-streams-input",
    getMetrics: () => metrics.getInputMetrics(),
    stream,
    close: () => Effect.promise(() => client.quit()),
  };
};
