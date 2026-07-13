/**
 * Redis List Input - Consumes messages from Redis Lists using blocking pop
 */
import { Effect, Stream, Option } from "effect";
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
import { withReconnect } from "./redis-reconnect.js";

export interface RedisListInputConfig {
  readonly host: string;
  readonly port: number;
  readonly key: string | string[]; // Single key or multiple keys to check
  readonly password?: string;
  readonly db?: number;

  // Pop configuration
  readonly direction?: "left" | "right"; // BLPOP (left) or BRPOP (right) (default: "left")
  readonly timeout?: number; // Blocking timeout in seconds (default: 5)

  // Connection configuration
  readonly connectTimeout?: number; // Connection timeout in ms (default: 10000)
  readonly commandTimeout?: number; // Command timeout in ms (default: undefined)
  readonly keepAlive?: number; // TCP keep-alive in ms (default: 30000)
  readonly lazyConnect?: boolean; // Defer connection until first command (default: false)
  readonly maxRetriesPerRequest?: number; // Max retries per request (default: 20)
  readonly enableOfflineQueue?: boolean; // Queue commands when offline (default: true)
  readonly maxReconnectAttempts?: number;
  readonly reconnectBackoffMs?: number;
}

export class RedisListInputError extends ComponentError {
  readonly _tag = "RedisListInputError";

  constructor(
    message: string,
    readonly category: ErrorCategory,
    cause?: unknown,
  ) {
    super(message, cause);
  }
}

/**
 * Validation schema for Redis List Input configuration
 */
export const RedisListInputConfigSchema = Schema.Struct({
  host: Schema.Union(Hostname, NonEmptyString),
  port: Port,
  key: Schema.Union(
    NonEmptyString,
    Schema.Array(NonEmptyString).pipe(Schema.minItems(1)),
  ),
  password: Schema.optional(NonEmptyString),
  db: Schema.optional(Schema.Int.pipe(Schema.nonNegative())),
  direction: Schema.optional(Schema.Literal("left", "right")),
  timeout: Schema.optional(PositiveInt),
  connectTimeout: Schema.optional(PositiveInt),
  commandTimeout: Schema.optional(PositiveInt),
  keepAlive: Schema.optional(PositiveInt),
  lazyConnect: Schema.optional(Schema.Boolean),
  maxRetriesPerRequest: Schema.optional(Schema.Int.pipe(Schema.nonNegative())),
  enableOfflineQueue: Schema.optional(Schema.Boolean),
  maxReconnectAttempts: Schema.optional(Schema.Int.pipe(Schema.nonNegative())),
  reconnectBackoffMs: Schema.optional(PositiveInt),
});

/**
 * Convert Redis list element to internal Message
 */
const convertListElement = (
  listKey: string,
  element: string,
): Effect.Effect<Message, RedisListInputError> =>
  Effect.gen(function* () {
    // Parse content with graceful degradation
    let content: unknown;
    try {
      content = JSON.parse(element);
    } catch (error) {
      // Graceful degradation: use raw content if parse fails
      yield* Effect.logDebug(
        `Failed to parse element from list ${listKey}, using raw value: ${error instanceof Error ? error.message : String(error)}`,
      );
      content = { raw: element };
    }

    // Build metadata
    const metadata: Record<string, any> = {
      source: "redis-list-input",
      listKey: listKey,
      receivedAt: new Date().toISOString(),
    };

    const msg = createMessage(content, metadata);
    return msg;
  });

/**
 * Create a Redis List input source
 */
export const createRedisListInput = (
  config: RedisListInputConfig,
): Input<RedisListInputError> => {
  // Validate configuration synchronously at creation time
  Effect.runSync(
    validate(
      RedisListInputConfigSchema,
      config,
      "Redis List Input configuration",
    ).pipe(
      Effect.catchAll((error) =>
        Effect.fail(
          new RedisListInputError(error.message, error.category, error),
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

  const direction = config.direction ?? "left";
  const timeout = config.timeout ?? 5;
  const keys = Array.isArray(config.key) ? config.key : [config.key];

  const metrics = new MetricsAccumulator("redis-list-input");
  let messageCount = 0;

  /**
   * Perform blocking pop operation
   */
  const blockingPop = Effect.gen(function* () {
    yield* Effect.logInfo(
      `Connected to Redis: redis://${config.host}:${config.port}/${config.db || 0}`,
    );
    yield* Effect.logDebug(
      `Polling Redis list(s) ${keys.join(", ")} with ${direction === "left" ? "BLPOP" : "BRPOP"}`,
    );

    const [result, duration] = yield* measureDuration(
      Effect.tryPromise({
        try: async () => {
          // BLPOP/BRPOP syntax: BLPOP key1 key2 ... timeout
          if (direction === "left") {
            return (await client.blpop(...keys, timeout)) as
              | [string, string]
              | null;
          } else {
            return (await client.brpop(...keys, timeout)) as
              | [string, string]
              | null;
          }
        },
        catch: (error) =>
          new RedisListInputError(
            `Failed to pop from Redis list: ${error instanceof Error ? error.message : String(error)}`,
            detectCategory(error),
            error,
          ),
      }),
    );

    // No element available (timeout)
    if (!result) {
      return null;
    }

    // Result is [key, element]
    const [listKey, element] = result;
    const msg = yield* convertListElement(listKey, element);

    // Record metrics
    metrics.recordProcessed(duration);
    messageCount++;

    // Emit metrics every 100 messages
    if (messageCount >= 100) {
      yield* emitInputMetrics(metrics.getInputMetrics());
      messageCount = 0;
    }

    yield* Effect.logDebug(`Popped message from Redis list ${listKey}`);
    return msg;
  });

  const resilientPop = withReconnect(
    blockingPop,
    {
      maxReconnectAttempts: config.maxReconnectAttempts,
      reconnectBackoffMs: config.reconnectBackoffMs,
    },
    (error, attempt, delayMs) =>
      Effect.sync(() => metrics.recordError()).pipe(
        Effect.zipRight(
          Effect.logWarning(
            `Redis list reconnect ${attempt} in ${delayMs}ms: ${error.message}`,
          ),
        ),
      ),
  );

  const stream = Stream.repeatEffect(resilientPop).pipe(
    Stream.filterMap((msg) => (msg ? Option.some(msg) : Option.none())), // Filter out nulls from timeout
  );

  return {
    name: "redis-list-input",
    getMetrics: () => metrics.getInputMetrics(),
    stream,
    close: () => Effect.promise(() => client.quit()),
  };
};
