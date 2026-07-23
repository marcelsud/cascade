/**
 * File Output - Writes newline-delimited records to a local file.
 *
 * @experimental This component is alpha. Config shape (in particular the
 * `format`/`mode` fields and their defaults) may change in a
 * backwards-incompatible way before it stabilizes.
 *
 * Shares serialization and the ordered writable coordinator with the stdout
 * output (see `./writable-output.ts`). The file destination and its lifecycle
 * are deliberately independent from record encoding so a future
 * `file.format: csv` can supply header/row strings to the same coordinator
 * without a new output type.
 */
import { Effect } from "effect";
import * as Schema from "effect/Schema";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Writable } from "node:stream";
import type { Output, Message } from "../core/types.js";
import { ComponentError, type ErrorCategory } from "../core/errors.js";
import {
  MetricsAccumulator,
  emitOutputMetrics,
  measureDuration,
} from "../core/metrics.js";
import { validate, NonEmptyString } from "../core/validation.js";
import {
  serializeMessage,
  createWriteCoordinator,
  StreamWriteError,
} from "./writable-output.js";

/**
 * @experimental Config shape may change before this component stabilizes.
 */
export interface FileOutputConfig {
  /** Destination file path. Its parent must already exist. */
  readonly path: string;
  /** "content" writes only message.content; "message" writes the full envelope (default: "content") */
  readonly format?: "content" | "message";
  /** "append" adds to the file; "overwrite" truncates once on first write (default: "append") */
  readonly mode?: "append" | "overwrite";
}

export class FileOutputError extends ComponentError {
  readonly _tag = "FileOutputError";

  constructor(
    message: string,
    readonly category: ErrorCategory,
    cause?: unknown,
  ) {
    super(message, cause);
  }
}

/**
 * Validation schema for File Output configuration
 */
export const FileOutputConfigSchema = Schema.Struct({
  path: NonEmptyString,
  format: Schema.optional(Schema.Literal("content", "message")),
  mode: Schema.optional(Schema.Literal("append", "overwrite")),
});

/** Map a coordinator failure phase onto this output's error category. */
const categoryForPhase = (error: unknown): ErrorCategory => {
  if (error instanceof StreamWriteError && error.phase === "open") {
    // A bad path (missing parent, directory target, permissions) — the
    // pipeline can't make progress by retrying, so stop.
    return "fatal";
  }
  // Runtime write/close failures are transient and safe to retry.
  return "intermittent";
};

/**
 * Create a File output
 *
 * @experimental Alpha component — see module docs.
 */
export const createFileOutput = (
  config: FileOutputConfig,
): Output<FileOutputError> => {
  Effect.runSync(
    validate(FileOutputConfigSchema, config, "File Output configuration").pipe(
      Effect.catchAll((error) =>
        Effect.fail(new FileOutputError(error.message, error.category, error)),
      ),
    ),
  );

  const format = config.format ?? "content";
  const mode = config.mode ?? "append";

  // Validate the parent up front but never create it or touch the target: a
  // bad destination should fail construction/`validate`, not mutate the fs.
  const parent = path.dirname(path.resolve(config.path));
  let parentStats: fs.Stats;
  try {
    parentStats = fs.statSync(parent);
  } catch (error) {
    throw new FileOutputError(
      `Parent directory does not exist: ${parent}`,
      "fatal",
      error,
    );
  }
  if (!parentStats.isDirectory()) {
    throw new FileOutputError(
      `Parent path is not a directory: ${parent}`,
      "fatal",
    );
  }

  const metrics = new MetricsAccumulator("file-output");
  let messageCount = 0;

  // Owned stream, opened lazily on the first send so that construction,
  // `cascade validate`, and zero-message runs never create or truncate the
  // file. "overwrite" truncates exactly once (the 'w' flag on the single lazy
  // open); "append" preserves existing content.
  const coordinator = createWriteCoordinator({
    owned: true,
    open: (): Writable =>
      fs.createWriteStream(config.path, {
        flags: mode === "overwrite" ? "w" : "a",
        encoding: "utf8",
      }),
  });

  return {
    name: "file-output",
    getMetrics: () => metrics.getOutputMetrics(),
    send: (msg: Message): Effect.Effect<void, FileOutputError> => {
      return Effect.gen(function* () {
        const line = yield* Effect.try({
          try: () => serializeMessage(msg, format),
          catch: (error) =>
            new FileOutputError(
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
              new FileOutputError(
                `Failed to write to file ${config.path}: ${error instanceof Error ? error.message : String(error)}`,
                categoryForPhase(error),
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
        // Flush and close the owned stream, surfacing any close failure.
        yield* Effect.tryPromise({
          try: () => coordinator.close(),
          catch: (error) =>
            new FileOutputError(
              `Failed to close file ${config.path}: ${error instanceof Error ? error.message : String(error)}`,
              categoryForPhase(error),
              error,
            ),
        });
      }),
  };
};
