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

const readRange = async (
  path: string,
  position: number,
  length: number,
): Promise<Buffer> => {
  const handle = await fsp.open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
};

const getIdentity = (stats: fs.Stats): string => `${stats.dev}:${stats.ino}`;

export const createFileInput = (
  config: FileInputConfig,
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
      metrics.recordProcessed(Date.now() - startedAt);
      messageCount++;

      if (messageCount % 100 === 0) {
        await Effect.runPromise(emitInputMetrics(metrics.getInputMetrics()));
      }
    }
  };

  const pollFile = async (): Promise<boolean> => {
    try {
      const stats = await fsp.stat(config.path);
      const nextIdentity = getIdentity(stats);

      if (nextIdentity !== currentIdentity || stats.size < currentPosition) {
        currentIdentity = nextIdentity;
        currentPosition = 0;
        bufferedText = "";
        decoder = new StringDecoder(encoding);
      }

      if (stats.size > currentPosition) {
        const chunk = await readRange(
          config.path,
          currentPosition,
          stats.size - currentPosition,
        );
        currentPosition += chunk.length;

        const [lines, remainder] = splitCompleteLines(
          bufferedText + decoder.write(chunk),
        );
        bufferedText = remainder;
        await emitLineMessages(lines);
      }

      if (!follow) {
        await shutdownQueue();
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
        await shutdownQueue();
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
    stream: Stream.fromQueue(queue),
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
