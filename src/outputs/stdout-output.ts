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
 * JSON.stringify silently *omits* an object key whose value is undefined, a
 * function, or a symbol — including when an object's toJSON() returns one of
 * those values. For root content that would either remove "content" from a
 * `message` envelope or write "undefined" in `content` format. Reject those
 * cases while preserving normal JSON semantics for nested fields.
 */
const isRootUnrepresentable = (value: unknown): boolean =>
  value === undefined ||
  typeof value === "function" ||
  typeof value === "symbol";

/**
 * Throws if content can't be turned into a line: the checks above catch
 * root-level undefined/function/symbol, and JSON.stringify itself throws on
 * circular references or BigInt (at any depth).
 */
const serialize = (msg: Message, format: "content" | "message"): string => {
  if (format === "message") {
    const envelope = {
      id: msg.id,
      correlationId: msg.correlationId,
      timestamp: msg.timestamp,
      content: msg.content,
      metadata: msg.metadata,
      trace: msg.trace,
    };
    const line = JSON.stringify(envelope, function (key, value) {
      if (
        this === envelope &&
        key === "content" &&
        isRootUnrepresentable(value)
      ) {
        throw new Error(
          `Message content of type "${typeof value}" cannot be represented in the stdout envelope`,
        );
      }
      return value;
    });
    if (line === undefined) {
      throw new Error("Message envelope is not JSON-serializable");
    }
    return line;
  }

  // format === "content": strings are written raw (not JSON-encoded),
  // everything else is JSON-serialized.
  if (typeof msg.content === "string") {
    return msg.content;
  }
  const line = JSON.stringify(msg.content);
  if (line === undefined) {
    throw new Error(
      `Message content of type "${typeof msg.content}" is not JSON-serializable`,
    );
  }
  return line;
};

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

  // A real Writable emits BOTH the write() callback and an 'error' event on
  // failure. Without an 'error' listener, Node treats that as an unhandled
  // error and throws (uncaughtException) even though the callback already
  // reports it. `settleCurrentWrite` lets whichever fires first resolve the
  // in-flight write; the other is a no-op via the `settled` guard below.
  let settleCurrentWrite: ((error?: Error | null) => void) | null = null;
  const onStreamError = (error: Error) => {
    const settle = settleCurrentWrite;
    settleCurrentWrite = null;
    if (settle) {
      settle(error);
    }
    // No write in flight: swallow so a stray/idle stream error never
    // becomes an uncaughtException. The next send() will surface any
    // persistent failure through its own write callback/error pairing.
  };
  stream.on("error", onStreamError);

  // Chain onto this promise so concurrent send() calls still write to the
  // stream in call order. It never rejects, so a failed write doesn't stall
  // messages queued behind it.
  let writeQueue: Promise<void> = Promise.resolve();

  const enqueueWrite = (line: string): Promise<void> => {
    const result = writeQueue.then(
      () =>
        new Promise<void>((resolve, reject) => {
          let settled = false;
          const settle = (error?: Error | null) => {
            if (settled) return;
            settled = true;
            settleCurrentWrite = null;
            if (error) reject(error);
            else resolve();
          };
          settleCurrentWrite = settle;
          stream.write(`${line}\n`, (error) => settle(error));
        }),
    );
    writeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  return {
    name: "stdout-output",
    getMetrics: () => metrics.getOutputMetrics(),
    send: (msg: Message): Effect.Effect<void, StdoutOutputError> => {
      return Effect.gen(function* () {
        const line = yield* Effect.try({
          try: () => serialize(msg, format),
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
            try: () => enqueueWrite(line),
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
        yield* Effect.promise(() => writeQueue);
        // Only remove the listener this output registered — the stream may
        // be process.stdout, which other code may also be observing.
        stream.removeListener("error", onStreamError);
      }),
  };
};
