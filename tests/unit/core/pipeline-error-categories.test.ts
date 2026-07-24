import { describe, expect, it } from "vitest";
import { Effect, Stream } from "effect";
import {
  ComponentError,
  type ErrorCategory,
} from "../../../src/core/errors.js";
import { run } from "../../../src/core/pipeline.js";
import { createMessage, type Message } from "../../../src/core/types.js";

class CategorizedTestError extends ComponentError {
  readonly _tag = "CategorizedTestError";
  constructor(
    message: string,
    readonly category: ErrorCategory,
  ) {
    super(message);
  }
}

const messages = (...contents: unknown[]): Message[] =>
  contents.map((content) => createMessage(content));

describe("pipeline error categories", () => {
  it("halts intake after a fatal processor error (concurrency 1)", async () => {
    const delivered: unknown[] = [];
    const inputMessages = messages(0, 1, 2);

    const result = await Effect.runPromise(
      run({
        name: "fatal-processor-halt",
        input: {
          name: "three",
          stream: Stream.fromIterable(inputMessages),
        },
        processors: [
          {
            name: "fatal-on-first",
            process: (msg) => {
              if (msg.content === 0) {
                return Effect.fail(
                  new CategorizedTestError("processor poison", "fatal"),
                );
              }
              return Effect.succeed(msg);
            },
          },
        ],
        output: {
          name: "capture",
          send: (msg) =>
            Effect.sync(() => {
              delivered.push(msg.content);
            }),
        },
        backpressure: { maxConcurrentMessages: 1 },
      }),
    );

    expect(result.success).toBe(false);
    expect(result.shutdown).toBeUndefined();
    expect(delivered).toEqual([]);
    expect(result.stats.failed).toBeGreaterThanOrEqual(1);
    expect(result.stats.processed).toBe(0);
    expect(
      result.errors?.some(
        (error) =>
          error instanceof CategorizedTestError &&
          error.message === "processor poison",
      ),
    ).toBe(true);
  });

  it("halts intake after a fatal output error before later deliveries", async () => {
    const delivered: unknown[] = [];
    const inputMessages = messages(0, 1, 2);

    const result = await Effect.runPromise(
      run({
        name: "fatal-output-halt",
        input: {
          name: "three",
          stream: Stream.fromIterable(inputMessages),
        },
        processors: [],
        output: {
          name: "fatal-on-first",
          send: (msg) => {
            if (msg.content === 0) {
              return Effect.fail(
                new CategorizedTestError("output poison", "fatal"),
              );
            }
            return Effect.sync(() => {
              delivered.push(msg.content);
            });
          },
        },
        backpressure: { maxConcurrentMessages: 1 },
      }),
    );

    expect(result.success).toBe(false);
    expect(result.shutdown).toBeUndefined();
    expect(delivered).toEqual([]);
    expect(result.stats.processed).toBe(0);
    expect(result.stats.failed).toBeGreaterThanOrEqual(1);
    expect(
      result.errors?.some(
        (error) =>
          error instanceof CategorizedTestError &&
          error.message === "output poison",
      ),
    ).toBe(true);
  });

  it("continues intake after a logical processor failure", async () => {
    const delivered: unknown[] = [];
    const inputMessages = messages(0, 1, 2);

    const result = await Effect.runPromise(
      run({
        name: "logical-continues",
        input: {
          name: "three",
          stream: Stream.fromIterable(inputMessages),
        },
        processors: [
          {
            name: "logical-on-first",
            process: (msg) => {
              if (msg.content === 0) {
                return Effect.fail(
                  new CategorizedTestError("bad payload", "logical"),
                );
              }
              return Effect.succeed(msg);
            },
          },
        ],
        output: {
          name: "capture",
          send: (msg) =>
            Effect.sync(() => {
              delivered.push(msg.content);
            }),
        },
        backpressure: { maxConcurrentMessages: 1 },
      }),
    );

    expect(result.success).toBe(false);
    expect(result.shutdown).toBeUndefined();
    expect(delivered).toEqual([1, 2]);
    expect(result.stats.processed).toBe(2);
    expect(result.stats.failed).toBe(1);
  });
});
