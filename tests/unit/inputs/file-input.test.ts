import { afterEach, describe, expect, it } from "vitest";
import { Duration, Effect, Stream } from "effect";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createFileInput } from "../../../src/inputs/file-input.js";
import { run } from "../../../src/core/pipeline.js";
import type { Output } from "../../../src/core/types.js";
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
});
