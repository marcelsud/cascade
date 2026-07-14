/**
 * Generate Input - Creates test messages from templates
 * Used for testing outputs and processors without external dependencies
 */
import { Effect, Stream } from "effect";
import * as Schema from "effect/Schema";
import { randomUUID } from "node:crypto";
import type { Input } from "../core/types.js";
import { createMessage } from "../core/types.js";
import { MetricsAccumulator } from "../core/metrics.js";

export interface GenerateInputConfig {
  readonly count: number;
  readonly interval?: number; // milliseconds between messages
  readonly template: Record<string, unknown>; // Template with {{placeholders}}
  readonly startIndex?: number; // Starting index (default: 0)
}

/**
 * Validation schema for Generate Input configuration
 */
export const GenerateInputConfigSchema = Schema.Struct({
  count: Schema.Int.pipe(Schema.positive()),
  interval: Schema.optional(Schema.Int.pipe(Schema.nonNegative())),
  template: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  startIndex: Schema.optional(Schema.Int.pipe(Schema.nonNegative())),
});

/**
 * Replace template placeholders with generated values
 */
const replacePlaceholders = (template: unknown, index: number): unknown => {
  if (typeof template === "string") {
    return template
      .replace(/\{\{index\}\}/g, String(index))
      .replace(/\{\{uuid\}\}/g, randomUUID())
      .replace(/\{\{random\}\}/g, String(Math.floor(Math.random() * 1000)))
      .replace(/\{\{timestamp\}\}/g, String(Date.now()));
  }

  if (Array.isArray(template)) {
    return template.map((item) => replacePlaceholders(item, index));
  }

  if (template !== null && typeof template === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(template)) {
      result[key] = replacePlaceholders(value, index);
    }
    return result;
  }

  return template;
};

/**
 * Create Generate Input
 *
 * @example
 * ```typescript
 * const input = createGenerateInput({
 *   count: 10,
 *   interval: 100,
 *   template: {
 *     id: "msg-{{index}}",
 *     value: "{{random}}",
 *     uuid: "{{uuid}}"
 *   }
 * })
 * ```
 */
export const createGenerateInput = (config: GenerateInputConfig): Input => {
  const startIndex = config.startIndex ?? 0;
  const interval = config.interval ?? 0;
  const metrics = new MetricsAccumulator("generate-input");

  // Create an array of indices to generate
  const indices = Array.from(
    { length: config.count },
    (_, i) => startIndex + i,
  );

  const stream = Stream.fromIterable(indices).pipe(
    // Add delay between messages if interval is specified
    Stream.mapEffect((index) =>
      Effect.gen(function* () {
        if (interval > 0 && index > startIndex) {
          yield* Effect.sleep(`${interval} millis`);
        }

        // Generate message from template
        const startedAt = performance.now();
        const content = replacePlaceholders(config.template, index);

        const message = createMessage(content, {
          source: "generate-input",
          testIndex: index,
          generatedAt: new Date().toISOString(),
        });
        metrics.recordProcessed(performance.now() - startedAt);
        return message;
      }),
    ),
  );

  return {
    name: "generate-input",
    stream,
    getMetrics: () => metrics.getInputMetrics(),
  };
};
