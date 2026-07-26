import { afterEach, describe, expect, it, vi } from "vitest";
import { Cause, Duration, Effect, Exit, Option, Stream } from "effect";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  createFileInput,
  FileInputError,
} from "../../../src/inputs/file-input.js";
import { run } from "../../../src/core/pipeline.js";
import type { Message, Output } from "../../../src/core/types.js";
import { createCaptureOutput } from "../../../src/testing/capture-output.js";

const createdPaths: string[] = [];
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const createTempFile = async (content = ""): Promise<string> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cascade-file-input-"));
  const filePath = path.join(dir, "input.log");
  await fs.writeFile(filePath, content, "utf8");
  createdPaths.push(dir);
  return filePath;
};

const collectChunk = async <T>(effect: Effect.Effect<Iterable<T>>) =>
  Array.from(await Effect.runPromise(effect));

const waitUntil = async (
  predicate: () => Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await delay(10);
  }
  return false;
};

const contentId = (content: unknown): number => {
  if (
    content !== null &&
    typeof content === "object" &&
    "id" in content &&
    typeof content.id === "number"
  ) {
    return content.id;
  }
  throw new Error(`expected content with numeric id, got ${String(content)}`);
};

const MAX_READ_CHUNK_BYTES = 64 * 1024;

const installBufferAllocSpy = (): {
  recorded: number[];
  restore: () => void;
} => {
  const recorded: number[] = [];
  const originalAlloc = Buffer.alloc.bind(Buffer);
  const spy = vi.spyOn(Buffer, "alloc").mockImplementation(function (
    this: unknown,
    size: number,
    fill?: string | number | Uint8Array,
    encoding?: BufferEncoding,
  ) {
    recorded.push(size);
    if (fill === undefined) {
      return originalAlloc(size);
    }
    if (encoding === undefined) {
      return originalAlloc(size, fill);
    }
    return originalAlloc(size, fill, encoding);
  } as typeof Buffer.alloc);
  return {
    recorded,
    restore: () => {
      spy.mockRestore();
    },
  };
};

const buildJsonlFixture = (recordCount: number): string =>
  Array.from({ length: recordCount }, (_, id) => JSON.stringify({ id })).join(
    "\n",
  ) + "\n";

afterEach(async () => {
  await Promise.all(
    createdPaths
      .splice(0)
      .map((target) => fs.rm(target, { recursive: true, force: true })),
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

  it("emits a final non-empty record without a trailing newline in one-shot mode", async () => {
    const filePath = await createTempFile('{"id":1}\n{"id":2}');
    const input = createFileInput({
      path: filePath,
      follow: false,
      startAt: "beginning",
      pollIntervalMs: 25,
    });

    const messages = await collectChunk(Stream.runCollect(input.stream));

    expect(messages).toHaveLength(2);
    expect(messages[0].content).toEqual({ id: 1 });
    expect(messages[1].content).toEqual({ id: 2 });
    expect(messages[1].metadata).toMatchObject({
      source: "file-input",
      path: filePath,
      lineNumber: 2,
    });

    expect(input.getMetrics?.()).toMatchObject({
      messagesProcessed: 2,
      messagesDropped: 0,
      errorsEncountered: 0,
    });
  });

  it("emits a single-record file with no trailing newline in one-shot mode", async () => {
    const filePath = await createTempFile('{"id":1}');
    const input = createFileInput({
      path: filePath,
      follow: false,
      startAt: "beginning",
      pollIntervalMs: 25,
    });

    const messages = await collectChunk(Stream.runCollect(input.stream));

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toEqual({ id: 1 });
    expect(messages[0].metadata).toMatchObject({
      source: "file-input",
      path: filePath,
      lineNumber: 1,
    });

    expect(input.getMetrics?.()).toMatchObject({
      messagesProcessed: 1,
      messagesDropped: 0,
      errorsEncountered: 0,
    });
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

  it.skipIf(process.platform !== "linux")(
    "closes the file handle before a blocking queue offer",
    async () => {
      const filePath = await createTempFile("first\nsecond\n");
      let releaseRead!: () => void;
      const readReleased = new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
      let openedFd!: string;
      let notifyReadStarted!: () => void;
      let rejectReadStarted!: (error: unknown) => void;
      const readStarted = new Promise<void>((resolve, reject) => {
        notifyReadStarted = resolve;
        rejectReadStarted = reject;
      });
      const input = createFileInput(
        {
          path: filePath,
          startAt: "beginning",
          pollIntervalMs: 25,
          queueSize: 1,
          overflow: "block",
        },
        {
          beforeRead: async () => {
            try {
              const fds = await fs.readdir("/proc/self/fd");
              for (const fd of fds) {
                const target = await fs
                  .readlink(`/proc/self/fd/${fd}`)
                  .catch(() => null);
                if (target === filePath) {
                  openedFd = fd;
                  notifyReadStarted();
                  break;
                }
              }
              if (!openedFd) {
                rejectReadStarted(
                  new Error(`No open descriptor found for ${filePath}`),
                );
              }
            } catch (error) {
              rejectReadStarted(error);
            }
            await readReleased;
          },
        },
      );

      try {
        await readStarted;
        releaseRead();

        const descriptorReleased = await waitUntil(
          () =>
            fs
              .readlink(`/proc/self/fd/${openedFd}`)
              .then((target) => target !== filePath)
              .catch(() => true),
          1_000,
        );
        expect(descriptorReleased).toBe(true);
      } finally {
        releaseRead();
        if (input.close) await Effect.runPromise(input.close());
      }
    },
  );

  it("drains buffered records before ending one-shot replay", async () => {
    const lines = Array.from({ length: 32 }, (_, id) =>
      JSON.stringify({ id }),
    ).join("\n");
    const filePath = await createTempFile(`${lines}\n`);
    const input = createFileInput({
      path: filePath,
      follow: false,
      startAt: "beginning",
      pollIntervalMs: 5,
      queueSize: 32,
      overflow: "block",
    });

    const produced = await waitUntil(
      async () => input.getMetrics?.()?.messagesProcessed === 32,
      5_000,
    );
    expect(produced).toBe(true);

    const messages = await collectChunk(Stream.runCollect(input.stream));
    expect(messages.map((message) => contentId(message.content))).toEqual(
      Array.from({ length: 32 }, (_, id) => id),
    );
  });

  it("delivers every line to a slow consumer when the file exceeds queue capacity", async () => {
    const lines = Array.from({ length: 64 }, (_, id) =>
      JSON.stringify({ id }),
    ).join("\n");
    const filePath = await createTempFile(`${lines}\n`);
    const input = createFileInput({
      path: filePath,
      follow: false,
      startAt: "beginning",
      pollIntervalMs: 5,
      queueSize: 4,
      overflow: "block",
    });

    const messages = await collectChunk(
      input.stream.pipe(
        Stream.tap(() => Effect.sleep(Duration.millis(1))),
        Stream.runCollect,
      ),
    );

    expect(messages.map((message) => contentId(message.content))).toEqual(
      Array.from({ length: 64 }, (_, id) => id),
    );
  }, 20_000);

  it("replays every line through a pipeline with a slow output", async () => {
    const lines = Array.from({ length: 16 }, (_, id) =>
      JSON.stringify({ id }),
    ).join("\n");
    const filePath = await createTempFile(`${lines}\n`);
    const input = createFileInput({
      path: filePath,
      follow: false,
      startAt: "beginning",
      pollIntervalMs: 5,
      queueSize: 2,
      overflow: "block",
    });

    const capture = await Effect.runPromise(createCaptureOutput());
    const slow: Output = {
      ...capture,
      send: (message) =>
        Effect.delay(capture.send(message), Duration.millis(2)),
    };

    const result = await Effect.runPromise(
      run({
        name: "file-input-drain-pipeline",
        input,
        processors: [],
        output: slow,
        backpressure: { maxConcurrentMessages: 1 },
      }),
    );

    expect(result.success).toBe(true);
    expect(result.stats.failed).toBe(0);
    expect(result.stats.processed).toBe(16);

    const messages = await Effect.runPromise(capture.getMessages());
    expect(messages).toHaveLength(16);
    expect(messages.map((message) => contentId(message.content))).toEqual(
      Array.from({ length: 16 }, (_, id) => id),
    );
    expect(result.metrics?.input).toMatchObject({
      component: "file-input",
      messagesProcessed: 16,
      messagesDropped: 0,
    });
  }, 20_000);

  it("close releases a producer blocked on queue capacity", async () => {
    const filePath = await createTempFile("one\ntwo\nthree\nfour\n");
    const input = createFileInput({
      path: filePath,
      follow: true,
      startAt: "beginning",
      pollIntervalMs: 5,
      queueSize: 1,
      overflow: "block",
    });

    // No consumer — producer blocks once the single-slot queue is full.
    const blocked = await waitUntil(
      async () => input.getMetrics?.()?.messagesProcessed === 1,
      5_000,
    );
    expect(blocked).toBe(true);

    const closeResult = await Promise.race([
      Effect.runPromise(input.close()).then(() => "closed" as const),
      delay(2_000).then(() => "timeout" as const),
    ]);

    expect(closeResult).toBe("closed");
  }, 20_000);

  it("caps allocations while draining a multi-chunk backlog", async () => {
    // Short newline-terminated records totaling well over four 64 KiB chunks.
    const recordCount = 30_000;
    const filePath = await createTempFile(buildJsonlFixture(recordCount));
    const stats = await fs.stat(filePath);
    expect(stats.size).toBeGreaterThan(4 * MAX_READ_CHUNK_BYTES);

    const { recorded, restore } = installBufferAllocSpy();
    try {
      const input = createFileInput({
        path: filePath,
        follow: true,
        startAt: "beginning",
        pollIntervalMs: 25,
        queueSize: 1,
        overflow: "block",
      });

      const messages = await collectChunk(
        input.stream.pipe(Stream.take(recordCount), Stream.runCollect),
      );

      if (input.close) {
        await Effect.runPromise(input.close());
      }

      expect(messages).toHaveLength(recordCount);
      expect(messages.map((message) => contentId(message.content))).toEqual(
        Array.from({ length: recordCount }, (_, id) => id),
      );
      expect(Math.max(...recorded)).toBeLessThanOrEqual(MAX_READ_CHUNK_BYTES);
      expect(input.getMetrics?.()).toMatchObject({
        messagesProcessed: recordCount,
        messagesDropped: 0,
        errorsEncountered: 0,
      });
    } finally {
      restore();
    }
  }, 60_000);

  it("does not read a second disk chunk while blocked on a full queue", async () => {
    // Three-plus chunks of short records; first chunk alone has many complete lines.
    const recordCount = 20_000;
    const filePath = await createTempFile(buildJsonlFixture(recordCount));
    const stats = await fs.stat(filePath);
    expect(stats.size).toBeGreaterThan(3 * MAX_READ_CHUNK_BYTES);

    const { recorded, restore } = installBufferAllocSpy();
    try {
      const input = createFileInput({
        path: filePath,
        follow: true,
        startAt: "beginning",
        pollIntervalMs: 25,
        queueSize: 1,
        overflow: "block",
      });

      // No consumer: first offer fills the single slot; the next offer blocks
      // inside emitLineMessages before any further chunk is materialized.
      const blocked = await waitUntil(
        async () => input.getMetrics?.()?.messagesProcessed === 1,
        5_000,
      );
      expect(blocked).toBe(true);

      const largeAllocsAtBlock = recorded.filter(
        (size) => size > 1_024 && size <= MAX_READ_CHUNK_BYTES,
      );
      expect(largeAllocsAtBlock.length).toBe(1);
      expect(Math.max(...recorded)).toBeLessThanOrEqual(MAX_READ_CHUNK_BYTES);

      await delay(150);
      const largeAllocsAfterWait = recorded.filter(
        (size) => size > 1_024 && size <= MAX_READ_CHUNK_BYTES,
      );
      expect(largeAllocsAfterWait.length).toBe(1);

      const messages = await collectChunk(
        input.stream.pipe(Stream.take(recordCount), Stream.runCollect),
      );

      if (input.close) {
        await Effect.runPromise(input.close());
      }

      expect(messages.map((message) => contentId(message.content))).toEqual(
        Array.from({ length: recordCount }, (_, id) => id),
      );
      expect(Math.max(...recorded)).toBeLessThanOrEqual(MAX_READ_CHUNK_BYTES);
    } finally {
      restore();
    }
  }, 60_000);

  it("preserves decode and line splits across chunk boundaries", async () => {
    const chunk = MAX_READ_CHUNK_BYTES;
    const euro = Buffer.from("€", "utf8"); // 3-byte UTF-8 code point

    // Chunk 1 ends mid-code-point: first byte of € is the last byte of chunk 1.
    const line1 = Buffer.concat([
      Buffer.alloc(chunk - 1, 0x61), // 'a' * (chunk - 1)
      euro,
      Buffer.from("tail1"),
    ]);

    // After line1 + "\n", pad so chunk 2 ends on '\r' and chunk 3 starts with '\n'.
    const afterLine1 = line1.length + 1; // + '\n'
    const padToCr = chunk * 2 - 1 - afterLine1;
    expect(padToCr).toBeGreaterThan(0);
    const line2 = Buffer.concat([
      Buffer.alloc(padToCr, 0x62), // 'b' *
      Buffer.from("\r"), // last byte of chunk 2
    ]);
    // '\n' is first byte of chunk 3 — completes the CRLF delimiter.

    // Chunk-3 body then LF-terminated line whose content itself spans into chunk 4.
    const line3PrefixLen = chunk - 1; // rest of chunk 3 after the leading '\n'
    const line3 = Buffer.concat([
      Buffer.alloc(line3PrefixLen, 0x63), // 'c' *
      Buffer.from("span"), // starts chunk 4
    ]);

    const fixture = Buffer.concat([
      line1,
      Buffer.from("\n"),
      line2,
      Buffer.from("\n"), // completes CRLF; starts chunk 3
      line3,
      Buffer.from("\n"),
      Buffer.from("final-line\n"),
    ]);

    expect(fixture.length).toBeGreaterThan(3 * chunk);

    // Sanity: the intended straddles land on chunk boundaries.
    expect(fixture[chunk - 1]).toBe(euro[0]);
    expect(fixture[chunk]).toBe(euro[1]);
    expect(fixture[chunk * 2 - 1]).toBe(0x0d); // \r
    expect(fixture[chunk * 2]).toBe(0x0a); // \n

    const expectedLines = [
      line1.toString("utf8"),
      line2.toString("utf8").replace(/\r$/, ""),
      line3.toString("utf8"),
      "final-line",
    ];

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cascade-file-input-"));
    createdPaths.push(dir);
    const filePath = path.join(dir, "boundary.log");
    await fs.writeFile(filePath, fixture);

    const input = createFileInput({
      path: filePath,
      follow: false,
      startAt: "beginning",
      pollIntervalMs: 25,
    });

    const messages = await collectChunk(Stream.runCollect(input.stream));

    expect(messages).toHaveLength(expectedLines.length);
    expect(
      messages.map((message) => {
        const content = message.content;
        if (
          content !== null &&
          typeof content === "object" &&
          "raw" in content &&
          typeof content.raw === "string"
        ) {
          return content.raw;
        }
        throw new Error(`expected raw content, got ${String(content)}`);
      }),
    ).toEqual(expectedLines);
    expect(messages.map((message) => message.metadata.lineNumber)).toEqual([
      1, 2, 3, 4,
    ]);
  }, 20_000);

  it("catches up in follow mode after a multi-chunk append while blocked", async () => {
    const filePath = await createTempFile("");
    const { recorded, restore } = installBufferAllocSpy();
    try {
      const input = createFileInput({
        path: filePath,
        follow: true,
        startAt: "end",
        pollIntervalMs: 20,
        queueSize: 1,
        overflow: "block",
      });

      // Seed one record so the producer blocks with a full single-slot queue.
      await delay(40);
      await fs.appendFile(filePath, '{"id":0}\n', "utf8");
      const blocked = await waitUntil(
        async () => input.getMetrics?.()?.messagesProcessed === 1,
        5_000,
      );
      expect(blocked).toBe(true);

      // Append well over four chunks while the producer cannot offer more.
      const appendedCount = 25_000;
      const appended =
        Array.from({ length: appendedCount }, (_, index) =>
          JSON.stringify({ id: index + 1 }),
        ).join("\n") + "\n";
      expect(Buffer.byteLength(appended)).toBeGreaterThan(
        4 * MAX_READ_CHUNK_BYTES,
      );
      await fs.appendFile(filePath, appended, "utf8");

      // Give the poller a chance to notice the growth; it must stay blocked on
      // the in-flight offer and must not allocate a whole-gap buffer.
      await delay(100);
      expect(Math.max(0, ...recorded)).toBeLessThanOrEqual(
        MAX_READ_CHUNK_BYTES,
      );

      const total = appendedCount + 1;
      const messages = await collectChunk(
        input.stream.pipe(Stream.take(total), Stream.runCollect),
      );

      if (input.close) {
        await Effect.runPromise(input.close());
      }

      expect(messages.map((message) => contentId(message.content))).toEqual(
        Array.from({ length: total }, (_, id) => id),
      );
      expect(Math.max(...recorded)).toBeLessThanOrEqual(MAX_READ_CHUNK_BYTES);
      expect(input.getMetrics?.()).toMatchObject({
        messagesProcessed: total,
        messagesDropped: 0,
        errorsEncountered: 0,
      });
    } finally {
      restore();
    }
  }, 60_000);

  it("caps allocations for one-shot beginning replay of a multi-chunk file", async () => {
    const recordCount = 30_000;
    const filePath = await createTempFile(buildJsonlFixture(recordCount));
    const stats = await fs.stat(filePath);
    expect(stats.size).toBeGreaterThan(4 * MAX_READ_CHUNK_BYTES);

    const { recorded, restore } = installBufferAllocSpy();
    try {
      const input = createFileInput({
        path: filePath,
        follow: false,
        startAt: "beginning",
        pollIntervalMs: 25,
        queueSize: 8,
        overflow: "block",
      });

      const messages = await collectChunk(Stream.runCollect(input.stream));

      expect(messages).toHaveLength(recordCount);
      expect(messages.map((message) => contentId(message.content))).toEqual(
        Array.from({ length: recordCount }, (_, id) => id),
      );
      expect(Math.max(...recorded)).toBeLessThanOrEqual(MAX_READ_CHUNK_BYTES);
      // Must not have allocated the whole unread gap in one Buffer.
      expect(recorded.some((size) => size >= stats.size)).toBe(false);
    } finally {
      restore();
    }
  }, 60_000);

  it("drains the old inode fully when rotation happens while blocked", async () => {
    // Multi-chunk old file so a blocked first-chunk offer still leaves unread
    // bytes on the rotated inode. Reopening the path mid-drain would abandon them.
    const oldCount = 20_000;
    const filePath = await createTempFile(buildJsonlFixture(oldCount));
    const stats = await fs.stat(filePath);
    expect(stats.size).toBeGreaterThan(3 * MAX_READ_CHUNK_BYTES);
    const rotatedPath = `${filePath}.1`;

    const input = createFileInput({
      path: filePath,
      follow: true,
      startAt: "beginning",
      pollIntervalMs: 20,
      queueSize: 1,
      overflow: "block",
    });

    const blocked = await waitUntil(
      async () => input.getMetrics?.()?.messagesProcessed === 1,
      5_000,
    );
    expect(blocked).toBe(true);

    // Rotate under the blocked producer: old inode still has unread chunks.
    await fs.rename(filePath, rotatedPath);
    await fs.writeFile(filePath, '{"id":999999}\n', "utf8");

    const total = oldCount + 1;
    const messages = await collectChunk(
      input.stream.pipe(Stream.take(total), Stream.runCollect),
    );

    if (input.close) {
      await Effect.runPromise(input.close());
    }

    expect(messages).toHaveLength(total);
    expect(messages.map((message) => contentId(message.content))).toEqual([
      ...Array.from({ length: oldCount }, (_, id) => id),
      999999,
    ]);
    expect(input.getMetrics?.()).toMatchObject({
      messagesProcessed: total,
      messagesDropped: 0,
      errorsEncountered: 0,
    });
  }, 60_000);

  it("restarts from byte 0 after copytruncate while blocked mid-drain", async () => {
    // Multi-chunk original so the producer is blocked on a first-chunk offer
    // with currentPosition still far below snapshotEof. copytruncate preserves
    // dev:ino; a replacement with currentPosition < size < snapshotEof must not
    // be read from the old offset (that silently drops the replacement prefix).
    const oldCount = 40_000;
    const filePath = await createTempFile(buildJsonlFixture(oldCount));
    const oldStats = await fs.stat(filePath);
    expect(oldStats.size).toBeGreaterThan(3 * MAX_READ_CHUNK_BYTES);
    const oldIdentity = `${oldStats.dev}:${oldStats.ino}`;

    const input = createFileInput({
      path: filePath,
      follow: true,
      startAt: "beginning",
      pollIntervalMs: 20,
      queueSize: 1,
      overflow: "block",
    });

    const blocked = await waitUntil(
      async () => input.getMetrics?.()?.messagesProcessed === 1,
      5_000,
    );
    expect(blocked).toBe(true);

    // Rough lower bound on how far the first chunk advanced the cursor.
    const minPositionAfterFirstChunk = MAX_READ_CHUNK_BYTES;

    const replacementStart = 100_000;
    const replacementCount = 20_000;
    const replacement =
      Array.from({ length: replacementCount }, (_, index) =>
        JSON.stringify({ id: replacementStart + index }),
      ).join("\n") + "\n";
    const replacementSize = Buffer.byteLength(replacement);
    // currentPosition < replacementSize < snapshotEof
    expect(replacementSize).toBeGreaterThan(minPositionAfterFirstChunk);
    expect(replacementSize).toBeLessThan(oldStats.size);

    // In-place truncate+rewrite preserves the inode (copytruncate).
    await fs.writeFile(filePath, replacement, "utf8");
    const rewrittenStats = await fs.stat(filePath);
    expect(`${rewrittenStats.dev}:${rewrittenStats.ino}`).toBe(oldIdentity);
    expect(rewrittenStats.size).toBe(replacementSize);

    const ids: number[] = [];
    const consuming = Effect.runPromise(
      input.stream.pipe(
        Stream.tap((message) =>
          Effect.sync(() => {
            const content = message.content;
            if (
              content !== null &&
              typeof content === "object" &&
              "id" in content &&
              typeof content.id === "number"
            ) {
              ids.push(content.id);
            }
          }),
        ),
        Stream.runDrain,
      ),
    );

    const expectedReplacement = Array.from(
      { length: replacementCount },
      (_, index) => replacementStart + index,
    );
    const sawFullReplacement = await waitUntil(async () => {
      const at = ids.indexOf(replacementStart);
      if (at < 0 || ids.length - at < replacementCount) {
        return false;
      }
      for (let i = 0; i < replacementCount; i++) {
        if (ids[at + i] !== expectedReplacement[i]) {
          return false;
        }
      }
      return true;
    }, 30_000);

    if (input.close) {
      await Effect.runPromise(input.close());
    }
    await Promise.race([consuming.then(() => undefined), delay(2_000)]);

    expect(sawFullReplacement).toBe(true);
    const replacementAt = ids.indexOf(replacementStart);
    expect(replacementAt).toBeGreaterThan(0);
    // Full ordered replacement — not a mid-file slice starting past byte 0.
    expect(ids.slice(replacementAt, replacementAt + replacementCount)).toEqual(
      expectedReplacement,
    );
    // Any pre-truncation records are a clean prefix of the old file.
    expect(ids.slice(0, replacementAt)).toEqual(
      Array.from({ length: replacementAt }, (_, id) => id),
    );
    expect(input.getMetrics?.()).toMatchObject({
      messagesDropped: 0,
      errorsEncountered: 0,
    });
  }, 60_000);

  it("one-shot replay does not include appends made while blocked", async () => {
    const originalCount = 20_000;
    const filePath = await createTempFile(buildJsonlFixture(originalCount));
    const stats = await fs.stat(filePath);
    expect(stats.size).toBeGreaterThan(3 * MAX_READ_CHUNK_BYTES);

    const input = createFileInput({
      path: filePath,
      follow: false,
      startAt: "beginning",
      pollIntervalMs: 20,
      queueSize: 1,
      overflow: "block",
    });

    const blocked = await waitUntil(
      async () => input.getMetrics?.()?.messagesProcessed === 1,
      5_000,
    );
    expect(blocked).toBe(true);

    // Append after the one-shot poll snapshotted EOF. Must not appear in replay.
    const appended =
      Array.from({ length: 100 }, (_, index) =>
        JSON.stringify({ id: originalCount + index }),
      ).join("\n") + "\n";
    await fs.appendFile(filePath, appended, "utf8");

    const messages = await collectChunk(Stream.runCollect(input.stream));

    expect(messages).toHaveLength(originalCount);
    expect(messages.map((message) => contentId(message.content))).toEqual(
      Array.from({ length: originalCount }, (_, id) => id),
    );
    expect(input.getMetrics?.()).toMatchObject({
      messagesProcessed: originalCount,
      messagesDropped: 0,
      errorsEncountered: 0,
    });
  }, 60_000);

  it("does not keep the process alive when a one-shot replay is abandoned", async () => {
    const lines = Array.from({ length: 32 }, (_, id) =>
      JSON.stringify({ id }),
    ).join("\n");
    const filePath = await createTempFile(`${lines}\n`);
    const fixturePath = path.join(
      "tests",
      "unit",
      "inputs",
      "__fixtures__",
      "abandoned-one-shot.ts",
    );

    const child = spawn("npx", ["tsx", fixturePath, filePath], {
      cwd: repoRoot,
      stdio: "ignore",
    });

    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 15_000);

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code));
    }).finally(() => {
      clearTimeout(timeout);
    });

    expect(timedOut).toBe(false);
    expect(exitCode).toBe(0);
  }, 30_000);

  it("terminates one-shot stream with FileInputError when first async read fails", async () => {
    const filePath = await createTempFile('{"id":1}\n{"id":2}\n');
    const input = createFileInput(
      {
        path: filePath,
        follow: false,
        startAt: "beginning",
        pollIntervalMs: 5,
      },
      {
        beforeRead: async () => {
          throw Object.assign(new Error("ENOENT: no such file or directory"), {
            code: "ENOENT",
          });
        },
      },
    );

    const exit = await Effect.runPromiseExit(Stream.runCollect(input.stream));

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Option.isSome(Cause.failureOption(exit.cause))).toBe(true);
      expect(Option.isNone(Cause.dieOption(exit.cause))).toBe(true);
      const failure = Option.getOrThrow(Cause.failureOption(exit.cause));
      expect(failure).toBeInstanceOf(FileInputError);
      expect(failure.message).toContain(filePath);
      expect(failure.message).toMatch(/ENOENT|no such file/i);
      expect(failure.category).toBe("fatal");
    }

    expect(input.getMetrics?.()).toMatchObject({
      messagesProcessed: 0,
      messagesDropped: 0,
      errorsEncountered: 1,
    });
  });

  it("drains accepted records in source order before terminal one-shot failure", async () => {
    // Multi-chunk fixture so the first 64 KiB of complete lines is emitted
    // before the injected second-read failure.
    const recordCount =
      Math.ceil((MAX_READ_CHUNK_BYTES + 2_048) / '{"id":0}\n'.length) + 8;
    const filePath = await createTempFile(buildJsonlFixture(recordCount));

    // node:fs/promises does not export FileHandle as a constructable class;
    // take the prototype from a live handle so we can fail the second disk read.
    const probe = await fs.open(filePath, "r");
    const fileHandleProto = Object.getPrototypeOf(probe) as {
      read: (...args: unknown[]) => Promise<unknown>;
    };
    const originalRead = fileHandleProto.read;
    await probe.close();

    let readCalls = 0;
    let spy: ReturnType<typeof vi.spyOn> | undefined;

    const input = createFileInput(
      {
        path: filePath,
        follow: false,
        startAt: "beginning",
        pollIntervalMs: 5,
        queueSize: recordCount,
        overflow: "block",
      },
      {
        beforeRead: async () => {
          spy = vi.spyOn(fileHandleProto, "read").mockImplementation(function (
            this: unknown,
            ...args: unknown[]
          ) {
            readCalls++;
            if (readCalls >= 2) {
              return Promise.reject(
                new Error("simulated mid-drain I/O failure"),
              );
            }
            return originalRead.apply(this, args);
          });
        },
      },
    );

    const collected: Message[] = [];
    try {
      const exit = await Effect.runPromiseExit(
        input.stream.pipe(
          Stream.tap((message) =>
            Effect.sync(() => {
              collected.push(message);
            }),
          ),
          Stream.runDrain,
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Option.isSome(Cause.failureOption(exit.cause))).toBe(true);
        expect(Option.isNone(Cause.dieOption(exit.cause))).toBe(true);
        const failure = Option.getOrThrow(Cause.failureOption(exit.cause));
        expect(failure).toBeInstanceOf(FileInputError);
        expect(failure.message).toContain("simulated mid-drain I/O failure");
      }

      expect(collected.length).toBeGreaterThan(0);
      expect(collected.length).toBeLessThan(recordCount);
      expect(collected.map((message) => contentId(message.content))).toEqual(
        Array.from({ length: collected.length }, (_, id) => id),
      );
      expect(input.getMetrics?.()).toMatchObject({
        messagesProcessed: collected.length,
        messagesDropped: 0,
        errorsEncountered: 1,
      });
    } finally {
      spy?.mockRestore();
    }
  });

  it("completes one-shot clean EOF successfully with all records", async () => {
    const filePath = await createTempFile(
      '{"id":0}\n{"id":1}\n{"id":2}\nplain\n',
    );
    const input = createFileInput({
      path: filePath,
      follow: false,
      startAt: "beginning",
      pollIntervalMs: 5,
    });

    const exit = await Effect.runPromiseExit(Stream.runCollect(input.stream));

    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      const messages = Array.from(exit.value);
      expect(messages).toHaveLength(4);
      expect(messages.map((message) => message.content)).toEqual([
        { id: 0 },
        { id: 1 },
        { id: 2 },
        { raw: "plain" },
      ]);
    }

    expect(input.getMetrics?.()).toMatchObject({
      messagesProcessed: 4,
      messagesDropped: 0,
      errorsEncountered: 0,
    });
  });

  it("pipeline reports failure when one-shot first async read fails", async () => {
    const filePath = await createTempFile('{"id":1}\n{"id":2}\n');
    const input = createFileInput(
      {
        path: filePath,
        follow: false,
        startAt: "beginning",
        pollIntervalMs: 5,
      },
      {
        beforeRead: async () => {
          throw Object.assign(new Error("ENOENT: no such file or directory"), {
            code: "ENOENT",
          });
        },
      },
    );

    const capture = await Effect.runPromise(createCaptureOutput());
    const result = await Effect.runPromise(
      run({
        name: "file-input-one-shot-read-failure",
        input,
        processors: [],
        output: capture,
      }),
    );

    expect(result.success).toBe(false);
    expect(result.stats.failed).toBeGreaterThanOrEqual(1);
    expect(
      result.errors?.some(
        (error) =>
          error instanceof FileInputError ||
          (error instanceof Error && error.message.includes("File input failed")),
      ),
    ).toBe(true);

    const messages = await Effect.runPromise(capture.getMessages());
    expect(messages).toHaveLength(0);
    expect(input.getMetrics?.()).toMatchObject({
      messagesProcessed: 0,
      errorsEncountered: 1,
    });
  });
});
