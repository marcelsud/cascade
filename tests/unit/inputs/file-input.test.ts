import { afterEach, describe, expect, it } from "vitest";
import { Effect, Stream } from "effect";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createFileInput } from "../../../src/inputs/file-input.js";

const createdPaths: string[] = [];

const createTempFile = async (content = ""): Promise<string> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cascade-file-input-"));
  const filePath = path.join(dir, "input.log");
  await fs.writeFile(filePath, content, "utf8");
  createdPaths.push(dir);
  return filePath;
};

const collectChunk = async <T>(effect: Effect.Effect<Iterable<T>>) =>
  Array.from(await Effect.runPromise(effect));

afterEach(async () => {
  await Promise.all(
    createdPaths.splice(0).map((target) =>
      fs.rm(target, { recursive: true, force: true }),
    ),
  );
});

describe("FileInput", () => {
  it("validates required path", () => {
    expect(() =>
      createFileInput({
        path: "",
      }),
    ).toThrow();
  });

  it("fails fast when the file does not exist", () => {
    expect(() =>
      createFileInput({
        path: path.join(os.tmpdir(), "cascade-missing-file.log"),
      }),
    ).toThrow(/Cannot stat input file/);
  });

  it("creates a stream and close handler with default configuration", async () => {
    const filePath = await createTempFile("");
    const input = createFileInput({ path: filePath });

    expect(input.name).toBe("file-input");
    expect(input.stream).toBeDefined();
    expect(input.close).toBeDefined();

    if (input.close) {
      await Effect.runPromise(input.close());
    }
  });

  it("reads existing lines from the beginning when configured", async () => {
    const filePath = await createTempFile('{"id":1}\nplain-text\n');
    const input = createFileInput({
      path: filePath,
      follow: false,
      startAt: "beginning",
      pollIntervalMs: 25,
    });

    const messages = await collectChunk(Stream.runCollect(input.stream));

    expect(messages).toHaveLength(2);
    expect(messages[0].content).toEqual({ id: 1 });
    expect(messages[0].metadata).toMatchObject({
      source: "file-input",
      path: filePath,
      lineNumber: 1,
    });
    expect(messages[1].content).toEqual({ raw: "plain-text" });
  });

  it("ignores pre-existing content in default tail mode and emits appended lines", async () => {
    const filePath = await createTempFile("existing\n");
    const input = createFileInput({
      path: filePath,
      pollIntervalMs: 25,
    });

    const collected = collectChunk(
      input.stream.pipe(Stream.take(2), Stream.runCollect),
    );

    await delay(80);
    await fs.appendFile(filePath, '{"id":2}\nplain\n', "utf8");

    const messages = await collected;
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toEqual({ id: 2 });
    expect(messages[1].content).toEqual({ raw: "plain" });

    if (input.close) {
      await Effect.runPromise(input.close());
    }
  });

  it("does not emit a partial trailing line until a newline is written", async () => {
    const filePath = await createTempFile("");
    const input = createFileInput({
      path: filePath,
      pollIntervalMs: 25,
    });

    const collected = collectChunk(
      input.stream.pipe(Stream.take(1), Stream.runCollect),
    );

    await delay(50);
    await fs.appendFile(filePath, "partial", "utf8");

    const earlyResult = await Promise.race([
      collected.then(() => "resolved"),
      delay(120).then(() => "pending"),
    ]);

    expect(earlyResult).toBe("pending");

    await fs.appendFile(filePath, "\n", "utf8");
    const messages = await collected;
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toEqual({ raw: "partial" });

    if (input.close) {
      await Effect.runPromise(input.close());
    }
  });

  it("falls back to raw content when a line is not valid JSON", async () => {
    const filePath = await createTempFile("not-json\n");
    const input = createFileInput({
      path: filePath,
      follow: false,
      startAt: "beginning",
      pollIntervalMs: 25,
    });

    const messages = await collectChunk(Stream.runCollect(input.stream));

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toEqual({ raw: "not-json" });
  });

  it("handles file rotation while following", async () => {
    const filePath = await createTempFile("");
    const rotatedPath = `${filePath}.1`;
    const input = createFileInput({
      path: filePath,
      pollIntervalMs: 25,
    });

    const collected = collectChunk(
      input.stream.pipe(Stream.take(2), Stream.runCollect),
    );

    await delay(50);
    await fs.appendFile(filePath, '{"step":1}\n', "utf8");
    await delay(80);
    await fs.rename(filePath, rotatedPath);
    await fs.writeFile(filePath, "after-rotate\n", "utf8");

    const messages = await collected;

    expect(messages).toHaveLength(2);
    expect(messages[0].content).toEqual({ step: 1 });
    expect(messages[1].content).toEqual({ raw: "after-rotate" });

    if (input.close) {
      await Effect.runPromise(input.close());
    }
  });

  it("follows rotation that happens between stat and read", async () => {
    const filePath = await createTempFile("before-rotation\n");
    const rotatedPath = `${filePath}.1`;
    let rotated = false;
    const input = createFileInput(
      {
        path: filePath,
        follow: true,
        startAt: "beginning",
        pollIntervalMs: 25,
      },
      {
        beforeRead: async () => {
          if (rotated) return;
          rotated = true;
          await fs.rename(filePath, rotatedPath);
          await fs.writeFile(filePath, "after-rotation\n", "utf8");
        },
      },
    );

    const messages = await collectChunk(
      input.stream.pipe(Stream.take(2), Stream.runCollect),
    );

    expect(messages).toHaveLength(2);
    expect(messages[0].content).toEqual({ raw: "before-rotation" });
    expect(messages[1].content).toEqual({ raw: "after-rotation" });

    if (input.close) await Effect.runPromise(input.close());
  });
});
