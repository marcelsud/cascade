/**
 * Stdout Output - Writes messages to a writable stream (stdout by default)
 *
 * @experimental This component is alpha. Config shape (in particular the
 * `format` field and its default) may change in a backwards-incompatible
 * way before it stabilizes. Data written by this output currently shares
 * `stdout` with CLI/pipeline log lines — no stream separation yet.
 */
import { Effect } from "effect";
import * as Schema from "effect/Schema";
import type { Writable } from "node:stream";
import type { Output, Message } from "../core/types.js";
import { ComponentError, type ErrorCategory } from "../core/errors.js";
import {
  MetricsAccumulator,
  emitOutputMetrics,
  measureDuration,
} from "../core/metrics.js";
import { validate } from "../core/validation.js";
import { serializeMessage, createWriteCoordinator } from "./writable-output.js";

/**
 * @experimental Config shape may change before this component stabilizes.
 */
export interface StdoutOutputConfig {
  /** "content" prints only message.content; "message" prints the full envelope (default: "content") */
  readonly format?: "content" | "message";
  /** Writable stream to write to (default: process.stdout). Intended for tests. */
  readonly stream?: Writable;
}

export class StdoutOutputError extends ComponentError {
  readonly _tag = "StdoutOutputError";

  constructor(
    message: string,
    readonly category: ErrorCategory,
    cause?: unknown,
  ) {
    super(message, cause);
  }
}

/**
 * Validation schema for Stdout Output configuration
 */
export const StdoutOutputConfigSchema = Schema.Struct({
  format: Schema.optional(Schema.Literal("content", "message")),
});

/**
 * Create a Stdout output
 *
 * @experimental Alpha component — see module docs.
 */
export const createStdoutOutput = (
  config: StdoutOutputConfig = {},
): Output<StdoutOutputError> => {
  Effect.runSync(
    validate(
      StdoutOutputConfigSchema,
      config,
      "Stdout Output configuration",
    ).pipe(
      Effect.catchAll((error) =>
        Effect.fail(
          new StdoutOutputError(error.message, error.category, error),
        ),
      ),
    ),
  );

  const format = config.format ?? "content";
  const stream = config.stream ?? process.stdout;

  const metrics = new MetricsAccumulator("stdout-output");
  let messageCount = 0;

  // Borrowed stream: process.stdout is shared with other code, so the
  // coordinator never ends it and only detaches its own error listener.
  const coordinator = createWriteCoordinator({ stream });

  return {
    name: "stdout-output",
    getMetrics: () => metrics.getOutputMetrics(),
    send: (msg: Message): Effect.Effect<void, StdoutOutputError> => {
      return Effect.gen(function* () {
        const line = yield* Effect.try({
          try: () => serializeMessage(msg, format),
          catch: (error) =>
            new StdoutOutputError(
              `Failed to serialize message ${msg.id}: ${error instanceof Error ? error.message : String(error)}`,
              "logical",
              error,
            ),
        }).pipe(
          Effect.tapError(() => {
            metrics.recordSendError();
            return Effect.void;
          }),
        );

        const [, duration] = yield* measureDuration(
          Effect.tryPromise({
            try: () => coordinator.write(line),
            catch: (error) =>
              new StdoutOutputError(
                `Failed to write to stdout: ${error instanceof Error ? error.message : String(error)}`,
                "intermittent",
                error,
              ),
          }).pipe(
            Effect.tapError(() => {
              metrics.recordSendError();
              return Effect.void;
            }),
          ),
        );

        metrics.recordSent(1, duration);
        messageCount++;

        if (messageCount >= 100) {
          yield* emitOutputMetrics(metrics.getOutputMetrics());
          messageCount = 0;
        }
      });
    },
    close: () =>
      Effect.gen(function* () {
        if (messageCount > 0) {
          yield* emitOutputMetrics(metrics.getOutputMetrics());
        }
        // Wait for any in-flight writes; never end the shared stream.
        yield* Effect.promise(() => coordinator.close());
      }),
  };
};
