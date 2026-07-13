/**
 * Capture Output - Collects messages in memory for testing assertions
 * Used for validating inputs and processors without external dependencies
 */
import { Effect, Ref } from "effect";
import type { Output, Message } from "../core/types.js";
import { MetricsAccumulator } from "../core/metrics.js";

export interface CaptureOutputConfig {
  readonly maxMessages?: number; // Limit captured messages (prevent memory issues)
}

/**
 * Capture Output instance with methods to retrieve captured messages
 */
export interface CaptureOutput extends Output {
  /**
   * Get all captured messages
   */
  getMessages: () => Effect.Effect<readonly Message[]>;

  /**
   * Get count of captured messages
   */
  getCount: () => Effect.Effect<number>;

  /**
   * Clear captured messages
   */
  clear: () => Effect.Effect<void>;
}

/**
 * Create Capture Output
 *
 * Captures messages in memory for testing assertions.
 * Access captured messages via `getMessages()`.
 *
 * @example
 * ```typescript
 * const output = createCaptureOutput()
 *
 * // ... run pipeline with capture output ...
 *
 * const messages = await Effect.runPromise(output.getMessages())
 * expect(messages).toHaveLength(10)
 * expect(messages[0].content).toEqual({ id: "msg-0" })
 * ```
 */
export const createCaptureOutput = (
  config: CaptureOutputConfig = {},
): Effect.Effect<CaptureOutput> =>
  Effect.gen(function* () {
    const maxMessages = config.maxMessages ?? 10000;
    const messagesRef = yield* Ref.make<Message[]>([]);
    const metrics = new MetricsAccumulator("capture-output");

    return {
      name: "capture-output",

      send: (message: Message) =>
        Effect.gen(function* () {
          const messages = yield* Ref.get(messagesRef);

          // Prevent memory issues with very large test runs
          if (messages.length >= maxMessages) {
            yield* Effect.logWarning(
              `Capture output reached max capacity (${maxMessages}). Dropping message.`,
            );
            return;
          }

          yield* Ref.update(messagesRef, (msgs) => [...msgs, message]);
          metrics.recordSent();
          yield* Effect.logDebug(`Captured message: ${message.id}`);
        }),

      getMessages: () => Ref.get(messagesRef),

      getCount: () =>
        Effect.gen(function* () {
          const messages = yield* Ref.get(messagesRef);
          return messages.length;
        }),

      clear: () => Ref.set(messagesRef, []),

      getMetrics: () => metrics.getOutputMetrics(),

      close: () =>
        Effect.gen(function* () {
          const count = yield* Ref.get(messagesRef).pipe(
            Effect.map((msgs) => msgs.length),
          );
          yield* Effect.log(
            `Capture output closing with ${count} captured messages`,
          );
          // Don't clear messages on close - they need to be available for test assertions
        }),
    };
  });
