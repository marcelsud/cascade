import { describe, expect, it } from "vitest";
import { Effect, Stream } from "effect";
import { PassThrough } from "node:stream";
import { createStdinInput } from "../../../src/inputs/stdin-input.js";

const collectChunk = async <T>(effect: Effect.Effect<Iterable<T>>) =>
  Array.from(await Effect.runPromise(effect));

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
});
