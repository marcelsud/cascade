/**
 * File Input - Reads newline-delimited messages from a local file
 */
import { Effect, Queue, Stream } from "effect";
import * as Schema from "effect/Schema";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import type { Input, Message } from "../core/types.js";
import { ComponentError, type ErrorCategory } from "../core/errors.js";
import { MetricsAccumulator, emitInputMetrics } from "../core/metrics.js";
import { validate, NonEmptyString, PositiveInt } from "../core/validation.js";
import { createTextMessage, splitCompleteLines } from "./text-input-utils.js";
import {
  createInputQueue,
  offerInputQueue,
  recordQueueDrop,
  streamInputQueue,
  type OverflowPolicy,
} from "./input-queue.js";

export interface FileInputConfig {
  readonly path: string;
  readonly follow?: boolean;
  readonly startAt?: "end" | "beginning";
  readonly pollIntervalMs?: number;
  readonly encoding?: string;
  readonly queueSize?: number;
  readonly overflow?: OverflowPolicy;
}

/** @internal Test seam for coordinating filesystem races. */
export interface FileInputDependencies {
  readonly beforeRead?: () => Promise<void>;
}

export class FileInputError extends ComponentError {
  readonly _tag = "FileInputError";

  constructor(
    message: string,
    readonly category: ErrorCategory,
    cause?: unknown,
  ) {
    super(message, cause);
  }
}

export const FileInputConfigSchema = Schema.Struct({
  path: NonEmptyString,
  follow: Schema.optional(Schema.Boolean),
  startAt: Schema.optional(Schema.Literal("end", "beginning")),
  pollIntervalMs: Schema.optional(PositiveInt),
  encoding: Schema.optional(NonEmptyString),
  queueSize: Schema.optional(PositiveInt),
  overflow: Schema.optional(Schema.Literal("block", "drop_new", "drop_old")),
});

/** Upper bound for a single disk read / Buffer allocation. */
const MAX_READ_CHUNK_BYTES = 64 * 1024;

const readRange = async (
  handle: fsp.FileHandle,
  position: number,
  length: number,
): Promise<Buffer> => {
  const toRead = Math.min(length, MAX_READ_CHUNK_BYTES);
  if (toRead <= 0) {
    return Buffer.alloc(0);
  }
  const buffer = Buffer.alloc(toRead);
  const { bytesRead } = await handle.read(buffer, 0, toRead, position);
  return buffer.subarray(0, bytesRead);
};

const getIdentity = (stats: fs.Stats): string => `${stats.dev}:${stats.ino}`;

export const createFileInput = (
  config: FileInputConfig,
  dependencies: FileInputDependencies = {},
): Input<FileInputError> => {
  Effect.runSync(
    validate(FileInputConfigSchema, config, "File Input configuration").pipe(
      Effect.catchAll((error) =>
        Effect.fail(new FileInputError(error.message, error.category, error)),
      ),
    ),
  );

  let initialStats: fs.Stats;
  try {
    initialStats = fs.statSync(config.path);
  } catch (error) {
    throw new FileInputError(
      `Cannot stat input file: ${config.path}`,
      "fatal",
      error,
    );
  }

  if (!initialStats.isFile()) {
    throw new FileInputError(
      `Input path is not a regular file: ${config.path}`,
      "fatal",
    );
  }

  const follow = config.follow ?? true;
  const startAt = config.startAt ?? "end";
  const pollIntervalMs = config.pollIntervalMs ?? 500;
  const encoding = (config.encoding ?? "utf8") as BufferEncoding;
  const queueSize = config.queueSize ?? 1_000;
  const overflow = config.overflow ?? "block";
  const queue = Effect.runSync(createInputQueue<Message>(queueSize, overflow));
  const metrics = new MetricsAccumulator("file-input");
  const dropLogState = { lastLogAt: 0, suppressed: 0 };

  let closed = false;
  let queueClosed = false;
  let producerDone = false;
  /** One-shot terminal I/O failure; surfaced after the queue drains. */
  let terminalError: FileInputError | null = null;
  let timer: NodeJS.Timeout | null = null;
  let currentPosition = startAt === "end" ? initialStats.size : 0;
  let currentIdentity = getIdentity(initialStats);
  let bufferedText = "";
  let decoder = new StringDecoder(encoding);
  let lineNumber = 0;
  let messageCount = 0;

  const shutdownQueue = async (): Promise<void> => {
    if (queueClosed) {
      return;
    }
    queueClosed = true;
    await Effect.runPromise(Queue.shutdown(queue));
  };

  /**
   * One-shot completion. Production finishing is not consumption finishing, so
   * signal completion instead of shutting the queue down: `streamInputQueue`
   * drains what is still buffered and then ends. Shutting down is only safe
   * when nothing is buffered, and it is then also necessary — it wakes a
   * consumer already blocked on the empty queue.
   */
  const finishOneShot = async (): Promise<void> => {
    if (queueClosed) {
      return;
    }
    // Set the flag BEFORE checking size: a consumer that drains the queue in
    // between must find the flag already set, or it blocks forever.
    producerDone = true;
    const remaining = await Effect.runPromise(
      Queue.size(queue).pipe(Effect.catchAllCause(() => Effect.succeed(0))),
    );
    if (remaining <= 0) {
      await shutdownQueue();
    }
  };

  const emitLineMessages = async (lines: readonly string[]): Promise<void> => {
    for (const line of lines) {
      const startedAt = Date.now();
      const message = createTextMessage(line, {
        source: "file-input",
        path: config.path,
        lineNumber: ++lineNumber,
        readAt: new Date().toISOString(),
      });
      const offer = await Effect.runPromise(
        offerInputQueue(queue, message, overflow, queueSize),
      );
      if (offer.dropped > 0) {
        await Effect.runPromise(recordQueueDrop(metrics, dropLogState, "File"));
      }
      if (offer.accepted) {
        metrics.recordProcessed(Date.now() - startedAt);
        messageCount++;

        if (messageCount % 100 === 0) {
          await Effect.runPromise(emitInputMetrics(metrics.getInputMetrics()));
        }
      }
    }
  };

  const pollFile = async (): Promise<boolean> => {
    try {
      // Open and stat once per poll. Snapshot that descriptor's EOF and drain
      // only up to it in bounded chunks so rotation/growth is observed on the
      // *next* poll — never mid-drain via a reopened pathname.
      const handle = await fsp.open(config.path, "r");
      let pending: readonly string[] | null = null;
      try {
        const stats = await handle.stat();
        const nextIdentity = getIdentity(stats);

        if (nextIdentity !== currentIdentity || stats.size < currentPosition) {
          currentIdentity = nextIdentity;
          currentPosition = 0;
          bufferedText = "";
          decoder = new StringDecoder(encoding);
        }

        // Immutable ceiling for this poll. Growth is observed on the next
        // poll; a mid-drain shrink (copytruncate) is detected by re-stat.
        const snapshotEof = stats.size;

        if (snapshotEof > currentPosition) {
          await dependencies.beforeRead?.();

          while (!closed && currentPosition < snapshotEof) {
            // Re-stat the same descriptor before every chunk read that follows
            // an await (beforeRead above, or emitLineMessages below). Never
            // extend snapshotEof. If the file shrank, stop before decoding
            // replacement bytes from the old offset — the next poll restarts
            // at byte 0.
            const liveSize = (await handle.stat()).size;
            if (liveSize < snapshotEof) {
              currentPosition = 0;
              bufferedText = "";
              decoder = new StringDecoder(encoding);
              pending = null;
              break;
            }

            const chunk = await readRange(
              handle,
              currentPosition,
              Math.min(snapshotEof - currentPosition, MAX_READ_CHUNK_BYTES),
            );
            if (chunk.length === 0) {
              break;
            }

            currentPosition += chunk.length;
            const [lines, remainder] = splitCompleteLines(
              bufferedText + decoder.write(chunk),
            );
            bufferedText = remainder;

            const atSnapshotEof = currentPosition >= snapshotEof;
            if (atSnapshotEof) {
              // Close before offering the final chunk so a blocked
              // overflow:block offer does not pin the descriptor.
              pending = lines;
              break;
            }

            if (lines.length > 0) {
              await emitLineMessages(lines);
            }
          }
        }
      } finally {
        await handle.close();
      }

      if (pending && pending.length > 0) {
        await emitLineMessages(pending);
      }

      if (!follow) {
        if (bufferedText.length > 0) {
          const finalLine = bufferedText;
          bufferedText = "";
          await emitLineMessages([finalLine]);
        }
        await finishOneShot();
        return false;
      }

      return true;
    } catch (error) {
      if (closed) {
        return false;
      }

      metrics.recordError();
      await Effect.runPromise(
        Effect.logError(
          `File input error for ${config.path}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      ).catch(() => undefined);

      if (!follow) {
        terminalError = new FileInputError(
          `File input failed to read ${config.path}: ${error instanceof Error ? error.message : String(error)}`,
          "fatal",
          error,
        );
        await finishOneShot();
        return false;
      }

      return true;
    }
  };

  const schedulePoll = (): void => {
    if (closed) {
      return;
    }

    timer = setTimeout(() => {
      void pollLoop();
    }, pollIntervalMs);
  };

  const pollLoop = async (): Promise<void> => {
    if (closed) {
      return;
    }

    const shouldContinue = await pollFile();
    if (shouldContinue) {
      schedulePoll();
    }
  };

  void pollLoop();

  return {
    name: "file-input",
    getMetrics: () => metrics.getInputMetrics(),
    stream: streamInputQueue(queue, () => producerDone).pipe(
      Stream.concat(
        Stream.suspend(() =>
          terminalError ? Stream.fail(terminalError) : Stream.empty,
        ),
      ),
    ),
    close: () =>
      Effect.gen(function* () {
        closed = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        yield* Effect.promise(() => shutdownQueue()).pipe(
          Effect.catchAll(() => Effect.void),
        );
        yield* emitInputMetrics(metrics.getInputMetrics());
      }),
  };
};
