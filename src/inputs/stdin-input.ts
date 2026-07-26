/**
 * Stdin Input - Reads messages from standard input
 */
import { Effect, Option, Queue, Stream } from "effect";
import * as Schema from "effect/Schema";
import type { Readable } from "node:stream";
import type { Input, Message } from "../core/types.js";
import {
  ComponentError,
  detectCategory,
  type ErrorCategory,
} from "../core/errors.js";
import { MetricsAccumulator, emitInputMetrics } from "../core/metrics.js";
import { validate, NonEmptyString, PositiveInt } from "../core/validation.js";
import { createTextMessage, splitCompleteLines } from "./text-input-utils.js";
import {
  createInputQueue,
  offerInputQueue,
  recordQueueDrop,
  type OverflowPolicy,
} from "./input-queue.js";

export interface StdinInputConfig {
  readonly mode?: "lines" | "whole";
  readonly encoding?: string;
  readonly queueSize?: number;
  readonly overflow?: OverflowPolicy;
}

export class StdinInputError extends ComponentError {
  readonly _tag = "StdinInputError";

  constructor(
    message: string,
    readonly category: ErrorCategory,
    cause?: unknown,
  ) {
    super(message, cause);
  }
}

export const StdinInputConfigSchema = Schema.Struct({
  mode: Schema.optional(Schema.Literal("lines", "whole")),
  encoding: Schema.optional(NonEmptyString),
  queueSize: Schema.optional(PositiveInt),
  overflow: Schema.optional(Schema.Literal("block", "drop_new", "drop_old")),
});

/** In-memory terminal marker; never emitted on the public Message stream. */
const STDIN_EOF: unique symbol = Symbol("cascade.stdin.eof");
export const createStdinInput = (
  config: StdinInputConfig = {},
  readable: Readable = process.stdin,
): Input<StdinInputError> => {
  Effect.runSync(
    validate(StdinInputConfigSchema, config, "Stdin Input configuration").pipe(
      Effect.catchAll((error) =>
        Effect.fail(new StdinInputError(error.message, error.category, error)),
      ),
    ),
  );

  const mode = config.mode ?? "lines";
  const encoding = (config.encoding ?? "utf8") as BufferEncoding;
  const queueSize = config.queueSize ?? 1_000;
  const overflow = config.overflow ?? "block";
  const queue = Effect.runSync(
    createInputQueue<Message | typeof STDIN_EOF>(queueSize, overflow),
  );
  const metrics = new MetricsAccumulator("stdin-input");
  const dropLogState = { lastLogAt: 0, suppressed: 0 };

  let closed = false;
  let ended = false;
  let lineNumber = 0;
  let bufferedText = "";
  let wholeText = "";
  let messageCount = 0;
  let work = Promise.resolve();
  /** Set when the readable emits a terminal error; stream fails after drain. */
  let terminalError: Error | undefined;
  const shutdownQueue = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    await Effect.runPromise(Queue.shutdown(queue));
  };

  /** Normal EOF: enqueue a terminal marker so buffered messages drain first. */
  const signalEof = async (): Promise<void> => {
    if (closed || ended) {
      return;
    }
    ended = true;

    await Effect.runPromise(
      Effect.gen(function* () {
        if (overflow === "block") {
          // Bounded offer suspends until the consumer makes space.
          yield* Queue.offer(queue, STDIN_EOF);
          return;
        }

        // drop_new / drop_old: never reject or evict a message to admit EOF.
        // Wait for capacity, then offer the marker.
        while (!(yield* Queue.isShutdown(queue))) {
          if ((yield* Queue.size(queue)) < queueSize) {
            if (yield* Queue.offer(queue, STDIN_EOF)) {
              return;
            }
          }
          yield* Effect.yieldNow();
        }
      }).pipe(Effect.catchAllCause(() => Effect.void)),
    );
  };

  const offerMessage = async (value: string, line?: number): Promise<void> => {
    const startedAt = Date.now();
    const metadata: Record<string, unknown> = {
      source: "stdin-input",
      readAt: new Date().toISOString(),
    };

    if (typeof line === "number") {
      metadata.lineNumber = line;
    }

    const offer = await Effect.runPromise(
      offerInputQueue(
        queue,
        createTextMessage(value, metadata),
        overflow,
        queueSize,
      ).pipe(
        // Forced close shuts the queue down under a blocked offer; treat that
        // as rejection rather than a producer error.
        Effect.catchAllCause(() =>
          Effect.succeed({ accepted: false, dropped: 0 }),
        ),
      ),
    );
    if (offer.dropped > 0) {
      await Effect.runPromise(recordQueueDrop(metrics, dropLogState, "Stdin"));
    }
    if (offer.accepted) {
      metrics.recordProcessed(Date.now() - startedAt);
      messageCount++;

      if (messageCount % 100 === 0) {
        await Effect.runPromise(emitInputMetrics(metrics.getInputMetrics()));
      }
    }
  };

  const onData = (chunk: string | Buffer) => {
    work = work
      .then(async () => {
        const text =
          typeof chunk === "string" ? chunk : chunk.toString(encoding);

        if (mode === "whole") {
          wholeText += text;
          return;
        }

        const [lines, remainder] = splitCompleteLines(bufferedText + text);
        bufferedText = remainder;

        for (const line of lines) {
          await offerMessage(line, ++lineNumber);
        }
      })
      .catch((error) => {
        metrics.recordError();
        return Effect.runPromise(
          Effect.logError(
            `stdin-input chunk processing failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        ).catch(() => undefined);
      });
  };

  const onEnd = () => {
    work = work
      .then(async () => {
        if (mode === "whole") {
          if (wholeText.length > 0) {
            await offerMessage(wholeText);
          }
        } else if (bufferedText.length > 0) {
          await offerMessage(bufferedText, ++lineNumber);
          bufferedText = "";
        }

        await signalEof();
      })
      .catch((error) => {
        metrics.recordError();
        return Effect.runPromise(
          Effect.logError(
            `stdin-input finalization failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        ).catch(() => undefined);
      });
  };

  const onError = (error: Error) => {
    // Exactly once for this terminal event; do not flush partial payloads as EOF.
    metrics.recordError();
    terminalError = error;
    work = work
      .then(async () => {
        await signalEof();
      })
      .catch((finalizeError) => {
        return Effect.runPromise(
          Effect.logError(
            `stdin-input error finalization failed: ${finalizeError instanceof Error ? finalizeError.message : String(finalizeError)}`,
          ),
        ).catch(() => undefined);
      })
      .finally(() =>
        Effect.runPromise(
          Effect.logError(`stdin-input stream error: ${error.message}`),
        ).catch(() => undefined),
      );
  };

  readable.setEncoding(encoding);
  readable.on("data", onData);
  readable.on("end", onEnd);
  readable.on("error", onError);
  readable.resume();

  return {
    name: "stdin-input",
    getMetrics: () => metrics.getInputMetrics(),
    stream: Stream.fromQueue(queue).pipe(
      Stream.filterMapWhile((element) =>
        element === STDIN_EOF ? Option.none() : Option.some(element),
      ),
      // After complete pre-error records drain, fail the stream when the
      // readable ended via error rather than clean EOF.
      Stream.concat(
        Stream.suspend(() =>
          terminalError
            ? Stream.fail(
                new StdinInputError(
                  `stdin stream error: ${terminalError.message}`,
                  detectCategory(terminalError),
                  terminalError,
                ),
              )
            : Stream.empty,
        ),
      ),
    ),
    close: () =>
      Effect.gen(function* () {
        readable.off("data", onData);
        readable.off("end", onEnd);
        readable.off("error", onError);
        if ("pause" in readable && typeof readable.pause === "function") {
          readable.pause();
        }
        // Shut down first so blocked offers / EOF admission unblock, then
        // wait for the producer chain and emit final metrics.
        yield* Effect.promise(() => shutdownQueue()).pipe(
          Effect.catchAll(() => Effect.void),
        );
        yield* Effect.promise(() => work).pipe(
          Effect.catchAll(() => Effect.void),
        );
        yield* emitInputMetrics(metrics.getInputMetrics());
      }),
  };
};
