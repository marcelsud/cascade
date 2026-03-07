/**
 * Stdin Input - Reads messages from standard input
 */
import { Effect, Queue, Stream } from "effect";
import * as Schema from "effect/Schema";
import type { Readable } from "node:stream";
import type { Input, Message } from "../core/types.js";
import { ComponentError, type ErrorCategory } from "../core/errors.js";
import { MetricsAccumulator, emitInputMetrics } from "../core/metrics.js";
import { validate, NonEmptyString } from "../core/validation.js";
import { createTextMessage, splitCompleteLines } from "./text-input-utils.js";

export interface StdinInputConfig {
  readonly mode?: "lines" | "whole";
  readonly encoding?: string;
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
});

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
  const queue = Effect.runSync(Queue.unbounded<Message>());
  const metrics = new MetricsAccumulator("stdin-input");

  let queueClosed = false;
  let lineNumber = 0;
  let bufferedText = "";
  let wholeText = "";
  let messageCount = 0;
  let work = Promise.resolve();

  const shutdownQueue = async (): Promise<void> => {
    if (queueClosed) {
      return;
    }
    queueClosed = true;
    await Effect.runPromise(Queue.shutdown(queue));
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

    await Effect.runPromise(Queue.offer(queue, createTextMessage(value, metadata)));
    metrics.recordProcessed(Date.now() - startedAt);
    messageCount++;

    if (messageCount % 100 === 0) {
      await Effect.runPromise(emitInputMetrics(metrics.getInputMetrics()));
    }
  };

  const onData = (chunk: string | Buffer) => {
    work = work
      .then(async () => {
        const text = typeof chunk === "string" ? chunk : chunk.toString(encoding);

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

        await shutdownQueue();
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
    metrics.recordError();
    work = work.finally(() =>
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
    stream: Stream.fromQueue(queue),
    close: () =>
      Effect.gen(function* () {
        readable.off("data", onData);
        readable.off("end", onEnd);
        readable.off("error", onError);
        if ("pause" in readable && typeof readable.pause === "function") {
          readable.pause();
        }
        yield* Effect.promise(() => work).pipe(
          Effect.catchAll(() => Effect.void),
        );
        yield* Effect.promise(() => shutdownQueue()).pipe(
          Effect.catchAll(() => Effect.void),
        );
        yield* emitInputMetrics(metrics.getInputMetrics());
      }),
  };
};
