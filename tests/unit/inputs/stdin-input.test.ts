import { describe, expect, it } from "vitest";
import { Effect, Stream } from "effect";
import { PassThrough } from "node:stream";
import { run } from "../../../src/core/pipeline.js";
import type { InputMetrics } from "../../../src/core/metrics.js";
import { createStdinInput } from "../../../src/inputs/stdin-input.js";
import { createCaptureOutput } from "../../../src/testing/capture-output.js";

const collectChunk = async <T, E>(effect: Effect.Effect<Iterable<T>, E>) =>
  Array.from(await Effect.runPromise(effect as Effect.Effect<Iterable<T>>));

const contentOf = (messages: ReadonlyArray<{ content: unknown }>) =>
  messages.map((message) => message.content);

const TEST_TIMEOUT = "2 seconds";

/** Poll input metrics until `predicate` holds. Timeout is a failure guard only. */
const awaitMetrics = (
  getMetrics: (() => InputMetrics) | undefined,
  predicate: (metrics: InputMetrics) => boolean,
) =>
  Effect.gen(function* () {
    while (true) {
      const metrics = getMetrics?.();
      if (metrics && predicate(metrics)) {
        return metrics;
      }
      yield* Effect.yieldNow();
    }
  }).pipe(
    Effect.timeoutFail({
      duration: TEST_TIMEOUT,
      onTimeout: () => new Error("timed out waiting for stdin input metrics"),
    }),
  );

/** Let the producer chain finish normal EOF handling after metrics settle. */
const flushProducer = () =>
  Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));

describe("StdinInput", () => {
  it("creates a stream and close handler with defaults", async () => {
    const stream = new PassThrough();
    const input = createStdinInput({}, stream);

    expect(input.name).toBe("stdin-input");
    expect(input.stream).toBeDefined();
    expect(input.close).toBeDefined();

    stream.end();

    if (input.close) {
      await Effect.runPromise(input.close());
    }
  });

  it("emits one message per line by default", async () => {
    const stream = new PassThrough();
    const input = createStdinInput({}, stream);
    const collected = collectChunk(Stream.runCollect(input.stream));

    stream.write('{"id":1}\n');
    stream.write("plain\n");
    stream.end();

    const messages = await collected;

    expect(messages).toHaveLength(2);
    expect(messages[0].content).toEqual({ id: 1 });
    expect(messages[0].metadata).toMatchObject({
      source: "stdin-input",
      lineNumber: 1,
    });
    expect(messages[1].content).toEqual({ raw: "plain" });
  });

  it("emits a single message in whole mode", async () => {
    const stream = new PassThrough();
    const input = createStdinInput({ mode: "whole" }, stream);
    const collected = collectChunk(Stream.runCollect(input.stream));

    stream.write('{"batch":');
    stream.write('"ok"}');
    stream.end();

    const messages = await collected;

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toEqual({ batch: "ok" });
    expect(messages[0].metadata).toMatchObject({
      source: "stdin-input",
    });
    expect(messages[0].metadata.lineNumber).toBeUndefined();
  });

  it("falls back to raw content when line parsing fails", async () => {
    const stream = new PassThrough();
    const input = createStdinInput({}, stream);
    const collected = collectChunk(Stream.runCollect(input.stream));

    stream.end("not-json\n");

    const messages = await collected;

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toEqual({ raw: "not-json" });
  });

  it("emits the final unterminated line on EOF", async () => {
    const stream = new PassThrough();
    const input = createStdinInput({}, stream);
    const collected = collectChunk(Stream.runCollect(input.stream));

    stream.end("tail-without-newline");

    const messages = await collected;

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toEqual({ raw: "tail-without-newline" });
    expect(messages[0].metadata).toMatchObject({
      source: "stdin-input",
      lineNumber: 1,
    });
  });

  it("drains every accepted line past normal EOF with a delayed collector", async () => {
    const readable = new PassThrough();
    const input = createStdinInput(
      { mode: "lines", queueSize: 4, overflow: "block" },
      readable,
    );

    const messages = await Effect.runPromise(
      Effect.gen(function* () {
        // No consumer yet: records stay buffered so baseline Queue.shutdown
        // would drop them before the collector attaches.
        readable.end("1\n2\n3\n");
        yield* awaitMetrics(
          input.getMetrics,
          (metrics) => metrics.messagesProcessed === 3,
        );
        yield* flushProducer();

        const chunk = yield* Stream.runCollect(input.stream);
        return Array.from(chunk);
      }).pipe(
        Effect.timeoutFail({
          duration: TEST_TIMEOUT,
          onTimeout: () => new Error("delayed-collector line drain timed out"),
        }),
      ),
    );

    expect(contentOf(messages)).toEqual([1, 2, 3]);
    expect(input.getMetrics?.()).toMatchObject({
      messagesProcessed: 3,
      messagesDropped: 0,
      errorsEncountered: 0,
    });
  });

  it("emits a final unterminated line before normal completion with a delayed collector", async () => {
    const readable = new PassThrough();
    const input = createStdinInput(
      { mode: "lines", queueSize: 4, overflow: "block" },
      readable,
    );

    const messages = await Effect.runPromise(
      Effect.gen(function* () {
        readable.end("1\n2\ntail");
        yield* awaitMetrics(
          input.getMetrics,
          (metrics) => metrics.messagesProcessed === 3,
        );
        yield* flushProducer();

        const chunk = yield* Stream.runCollect(input.stream);
        return Array.from(chunk);
      }).pipe(
        Effect.timeoutFail({
          duration: TEST_TIMEOUT,
          onTimeout: () =>
            new Error("delayed-collector unterminated line timed out"),
        }),
      ),
    );

    expect(contentOf(messages)).toEqual([1, 2, { raw: "tail" }]);
  });

  it("emits a whole payload before normal completion with a delayed collector", async () => {
    const readable = new PassThrough();
    const input = createStdinInput(
      { mode: "whole", queueSize: 4, overflow: "block" },
      readable,
    );

    const messages = await Effect.runPromise(
      Effect.gen(function* () {
        readable.end('{"batch":true}');
        yield* awaitMetrics(
          input.getMetrics,
          (metrics) => metrics.messagesProcessed === 1,
        );
        yield* flushProducer();

        const chunk = yield* Stream.runCollect(input.stream);
        return Array.from(chunk);
      }).pipe(
        Effect.timeoutFail({
          duration: TEST_TIMEOUT,
          onTimeout: () =>
            new Error("delayed-collector whole payload timed out"),
        }),
      ),
    );

    expect(contentOf(messages)).toEqual([{ batch: true }]);
  });

  it("delivers every accepted stdin line through a no-filter pipeline", async () => {
    const readable = new PassThrough();
    const input = createStdinInput(
      { mode: "lines", queueSize: 4, overflow: "block" },
      readable,
    );
    const output = await Effect.runPromise(createCaptureOutput());

    // Fill the queue and finish normal EOF handling before the pipeline
    // attaches its consumer, so baseline shutdown loses buffered records.
    await Effect.runPromise(
      Effect.gen(function* () {
        readable.end("1\n2\n3\n");
        yield* awaitMetrics(
          input.getMetrics,
          (metrics) => metrics.messagesProcessed === 3,
        );
        yield* flushProducer();
      }).pipe(
        Effect.timeoutFail({
          duration: TEST_TIMEOUT,
          onTimeout: () => new Error("pipeline prefill timed out"),
        }),
      ),
    );

    const result = await Effect.runPromise(
      run({
        name: "stdin-eof-pipeline",
        input,
        processors: [],
        output,
      }).pipe(
        Effect.timeoutFail({
          duration: TEST_TIMEOUT,
          onTimeout: () => new Error("stdin EOF pipeline timed out"),
        }),
      ),
    );
    const messages = await Effect.runPromise(output.getMessages());

    expect(result.success).toBe(true);
    expect(result.stats.processed).toBe(3);
    expect(messages).toHaveLength(3);
    expect(contentOf(messages)).toEqual([1, 2, 3]);
    expect(result.metrics?.input).toMatchObject({
      component: "stdin-input",
      messagesProcessed: 3,
      messagesDropped: 0,
      errorsEncountered: 0,
    });
  });

  it("retains drop_new capacity semantics across normal EOF", async () => {
    const readable = new PassThrough();
    const input = createStdinInput(
      { mode: "lines", queueSize: 1, overflow: "drop_new" },
      readable,
    );

    const messages = await Effect.runPromise(
      Effect.gen(function* () {
        readable.end("1\n2\n3\n");
        // Producer finished offers; EOF admission is waiting on capacity.
        yield* awaitMetrics(
          input.getMetrics,
          (metrics) =>
            metrics.messagesProcessed === 1 && metrics.messagesDropped === 2,
        );

        const chunk = yield* Stream.runCollect(input.stream);
        return Array.from(chunk);
      }).pipe(
        Effect.timeoutFail({
          duration: TEST_TIMEOUT,
          onTimeout: () => new Error("drop_new EOF semantics timed out"),
        }),
      ),
    );

    expect(contentOf(messages)).toEqual([1]);
    expect(input.getMetrics?.()).toMatchObject({
      messagesProcessed: 1,
      messagesDropped: 2,
      errorsEncountered: 0,
    });
  });

  it("retains drop_old eviction semantics across normal EOF", async () => {
    const readable = new PassThrough();
    const input = createStdinInput(
      { mode: "lines", queueSize: 1, overflow: "drop_old" },
      readable,
    );

    const messages = await Effect.runPromise(
      Effect.gen(function* () {
        readable.end("1\n2\n3\n");
        // Sliding queue accepted all three; older two were evicted.
        yield* awaitMetrics(
          input.getMetrics,
          (metrics) =>
            metrics.messagesProcessed === 3 && metrics.messagesDropped >= 2,
        );

        const chunk = yield* Stream.runCollect(input.stream);
        return Array.from(chunk);
      }).pipe(
        Effect.timeoutFail({
          duration: TEST_TIMEOUT,
          onTimeout: () => new Error("drop_old EOF semantics timed out"),
        }),
      ),
    );

    expect(contentOf(messages)).toEqual([3]);
    expect(input.getMetrics?.()?.errorsEncountered).toBe(0);
  });

  it("completes explicit close while EOF admission waits on a full drop queue", async () => {
    const readable = new PassThrough();
    const input = createStdinInput(
      { mode: "lines", queueSize: 1, overflow: "drop_new" },
      readable,
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        // No consumer: accepted line fills capacity; EOF spins for space.
        readable.end("1\n2\n3\n");
        yield* awaitMetrics(
          input.getMetrics,
          (metrics) =>
            metrics.messagesProcessed === 1 && metrics.messagesDropped === 2,
        );

        yield* input.close!();
      }).pipe(
        Effect.timeoutFail({
          duration: TEST_TIMEOUT,
          onTimeout: () =>
            new Error("close while EOF admission waited timed out"),
        }),
      ),
    );

    expect(input.getMetrics?.()).toMatchObject({
      messagesProcessed: 1,
      messagesDropped: 2,
    });
  });
});
