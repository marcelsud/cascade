import { afterEach, describe, it, expect, vi } from "vitest";
import { Effect } from "effect";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Writable } from "node:stream";
import { EventEmitter } from "node:events";
import {
  createStdoutOutput,
  StdoutOutputError,
} from "../../../src/outputs/stdout-output.js";
import { createMessage } from "../../../src/core/types.js";
import { loadConfig } from "../../../src/core/config-loader.js";
import { buildPipeline } from "../../../src/core/pipeline-builder.js";

/**
 * A real node:stream Writable, not a plain-object stand-in. This matters:
 * a real Writable emits BOTH the write() callback and an 'error' event on
 * failure, and (matching process.stdout in this environment) auto-destroys
 * itself after a callback error — every write after that also fails. Using
 * the real thing is what caught the original uncaughtException bug; a
 * hand-rolled mock without EventEmitter semantics would mask it again.
 */
const createMockStream = (
  opts: { delayMs?: number; highWaterMark?: number } = {},
) => {
  const chunks: string[] = [];
  let failNext = false;

  const stream = new Writable({
    decodeStrings: false,
    highWaterMark: opts.highWaterMark,
    write(chunk, _encoding, callback) {
      const finish = () => {
        if (failNext) {
          failNext = false;
          callback(new Error("write failed"));
          return;
        }
        chunks.push(chunk as string);
        callback();
      };
      if (opts.delayMs) {
        setTimeout(finish, opts.delayMs);
      } else {
        finish();
      }
    },
  });

  return {
    stream,
    chunks,
    failNextWrite: () => {
      failNext = true;
    },
  };
};

/**
 * A minimal EventEmitter-backed Writable stand-in that mirrors a real
 * stream's dual failure signal (write callback error + 'error' event fired
 * for the same failure) but — unlike a real node:stream Writable — stays
 * usable afterwards. A real Writable is unusable here: even with
 * `autoDestroy: false` it wedges permanently in an internal "errored" state
 * and the next write's callback simply never fires (verified empirically).
 * This fake isolates "does the output's own write queue recover after one
 * failed entry" from that Node stream-internals limitation.
 */
const createRecoverableStream = () => {
  const chunks: string[] = [];
  let failNext = false;
  const emitter = new EventEmitter();

  const stream = Object.assign(emitter, {
    write(chunk: string, callback: (error?: Error | null) => void): boolean {
      if (failNext) {
        failNext = false;
        const error = new Error("transient failure");
        callback(error);
        emitter.emit("error", error);
        return false;
      }
      chunks.push(chunk);
      callback(null);
      return true;
    },
    end: vi.fn(),
    destroy: vi.fn(),
  }) as unknown as Writable;

  return {
    stream,
    chunks,
    failNextWrite: () => {
      failNext = true;
    },
  };
};

/** Detect an uncaughtException raised anywhere during `run()`. */
const withUncaughtExceptionGuard = async (
  run: () => Promise<void>,
): Promise<{ uncaught: Error[] }> => {
  const uncaught: Error[] = [];
  const handler = (error: Error) => uncaught.push(error);
  process.on("uncaughtException", handler);
  try {
    await run();
    // Let any queued microtask/'error' event that would have crashed the
    // process actually fire before we check.
    await new Promise((resolve) => setTimeout(resolve, 10));
  } finally {
    process.removeListener("uncaughtException", handler);
  }
  return { uncaught };
};

const createdPaths: string[] = [];

const createTempDir = async (): Promise<string> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cascade-config-"));
  createdPaths.push(dir);
  return dir;
};

afterEach(async () => {
  await Promise.all(
    createdPaths
      .splice(0)
      .map((target) => fs.rm(target, { recursive: true, force: true })),
  );
});

describe("StdoutOutput", () => {
  describe("YAML pipeline build", () => {
    it("loads and builds a pipeline with stdout output", async () => {
      const dir = await createTempDir();
      const configPath = path.join(dir, "stdout-pipeline.yaml");

      await fs.writeFile(
        configPath,
        `input:
  generate:
    count: 1
    template: { value: "test" }
output:
  stdout:
    format: message
`,
        "utf8",
      );

      const config = await Effect.runPromise(loadConfig(configPath));
      const pipeline = await Effect.runPromise(buildPipeline(config));

      expect(pipeline.output.name).toBe("stdout-output");

      if (pipeline.output.close) {
        await Effect.runPromise(pipeline.output.close());
      }
    });

    it("defaults format when omitted in YAML", async () => {
      const dir = await createTempDir();
      const configPath = path.join(dir, "stdout-default-pipeline.yaml");

      await fs.writeFile(
        configPath,
        `input:
  generate:
    count: 1
    template: { value: "test" }
output:
  stdout: {}
`,
        "utf8",
      );

      const config = await Effect.runPromise(loadConfig(configPath));
      const pipeline = await Effect.runPromise(buildPipeline(config));

      expect(pipeline.output.name).toBe("stdout-output");

      if (pipeline.output.close) {
        await Effect.runPromise(pipeline.output.close());
      }
    });
  });

  describe("Configuration Validation", () => {
    it("creates output with no config (defaults)", () => {
      expect(() => createStdoutOutput()).not.toThrow();
    });

    it("accepts format: content", () => {
      expect(() => createStdoutOutput({ format: "content" })).not.toThrow();
    });

    it("accepts format: message", () => {
      expect(() => createStdoutOutput({ format: "message" })).not.toThrow();
    });

    it("rejects an invalid format", () => {
      expect(() => createStdoutOutput({ format: "invalid" as any })).toThrow();
    });
  });

  describe("content format (default)", () => {
    it("writes string content raw, not JSON-encoded", async () => {
      const { stream, chunks } = createMockStream();
      const output = createStdoutOutput({ stream });

      await Effect.runPromise(output.send(createMessage("hello")));

      expect(chunks).toEqual(["hello\n"]);
    });

    it("writes object content as JSON", async () => {
      const { stream, chunks } = createMockStream();
      const output = createStdoutOutput({ stream });

      await Effect.runPromise(output.send(createMessage({ id: 1, ok: true })));

      expect(chunks).toEqual([JSON.stringify({ id: 1, ok: true }) + "\n"]);
    });

    it("defaults to content format when format is omitted", async () => {
      const { stream, chunks } = createMockStream();
      const output = createStdoutOutput({ stream });

      await Effect.runPromise(output.send(createMessage("plain")));

      expect(chunks).toEqual(["plain\n"]);
    });

    it("preserves raw multiline strings exactly, adding only the trailing delimiter", async () => {
      const { stream, chunks } = createMockStream();
      const output = createStdoutOutput({ stream });

      await Effect.runPromise(output.send(createMessage("first\nsecond")));

      expect(chunks).toEqual(["first\nsecond\n"]);
    });
  });

  describe("message format", () => {
    it("writes the full message envelope as JSON", async () => {
      const { stream, chunks } = createMockStream();
      const output = createStdoutOutput({ stream, format: "message" });

      const msg = createMessage("hello", { source: "test" });
      await Effect.runPromise(output.send(msg));

      const parsed = JSON.parse(chunks[0]);
      expect(parsed).toMatchObject({
        id: msg.id,
        timestamp: msg.timestamp,
        content: "hello",
        metadata: { source: "test" },
      });
    });

    it("always emits a single physical line, even for multiline string content", async () => {
      const { stream, chunks } = createMockStream();
      const output = createStdoutOutput({ stream, format: "message" });

      await Effect.runPromise(output.send(createMessage("first\nsecond")));

      expect(chunks).toHaveLength(1);
      expect(chunks[0].split("\n")).toHaveLength(2); // JSON body + trailing delimiter
      expect(JSON.parse(chunks[0]).content).toBe("first\nsecond");
    });
  });

  describe("message format content validation", () => {
    const expectRejectedAsLogical = async (content: unknown) => {
      const { stream, chunks } = createMockStream();
      const output = createStdoutOutput({ stream, format: "message" });

      const exit = await Effect.runPromiseExit(
        output.send(createMessage(content as any)),
      );

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
        expect(exit.cause.error).toBeInstanceOf(StdoutOutputError);
        expect((exit.cause.error as StdoutOutputError).category).toBe(
          "logical",
        );
      }
      // Content must never be silently dropped: no line is written at all.
      expect(chunks).toEqual([]);
    };

    it("rejects undefined root content instead of dropping the field", () =>
      expectRejectedAsLogical(undefined));

    it("rejects function root content", () =>
      expectRejectedAsLogical(() => {}));

    it("rejects symbol root content", () =>
      expectRejectedAsLogical(Symbol("x")));

    it("rejects circular reference content", () => {
      const circular: any = {};
      circular.self = circular;
      return expectRejectedAsLogical(circular);
    });

    it("rejects BigInt content", () => expectRejectedAsLogical(10n));

    it("preserves normal JSON.stringify semantics for nested undefined fields", async () => {
      const { stream, chunks } = createMockStream();
      const output = createStdoutOutput({ stream, format: "message" });

      await Effect.runPromise(
        output.send(createMessage({ keep: "yes", drop: undefined })),
      );

      const parsed = JSON.parse(chunks[0]);
      expect(parsed.content).toEqual({ keep: "yes" });
    });

    it("rejects root content whose toJSON returns undefined", () =>
      expectRejectedAsLogical({ toJSON: () => undefined }));
  });

  describe("non-serializable content (content format)", () => {
    it("fails with a typed StdoutOutputError on circular content, not a defect", async () => {
      const { stream, chunks } = createMockStream();
      const output = createStdoutOutput({ stream });

      const circular: any = {};
      circular.self = circular;

      const exit = await Effect.runPromiseExit(
        output.send(createMessage(circular)),
      );

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(exit.cause._tag).toBe("Fail");
        if (exit.cause._tag === "Fail") {
          expect(exit.cause.error).toBeInstanceOf(StdoutOutputError);
          expect((exit.cause.error as StdoutOutputError).category).toBe(
            "logical",
          );
        }
      }
      expect(chunks).toEqual([]);
    });

    it("fails instead of writing the literal string 'undefined'", async () => {
      const { stream, chunks } = createMockStream();
      const output = createStdoutOutput({ stream });

      await expect(
        Effect.runPromise(output.send(createMessage(undefined))),
      ).rejects.toThrow();

      expect(chunks).toEqual([]);
    });

    it("records a send error for non-serializable content", async () => {
      const { stream } = createMockStream();
      const output = createStdoutOutput({ stream });

      await Effect.runPromise(
        output
          .send(createMessage(undefined))
          .pipe(Effect.catchAll(() => Effect.void)),
      );

      expect(output.getMetrics?.().sendErrors).toBe(1);
    });

    it("resumes writing subsequent messages after a serialization failure", async () => {
      const { stream, chunks } = createMockStream();
      const output = createStdoutOutput({ stream });

      await Effect.runPromise(
        output
          .send(createMessage(undefined))
          .pipe(Effect.catchAll(() => Effect.void)),
      );
      await Effect.runPromise(output.send(createMessage("recovered")));

      expect(chunks).toEqual(["recovered\n"]);
    });

    it("rejects content whose toJSON returns undefined instead of writing it", async () => {
      const { stream, chunks } = createMockStream();
      const output = createStdoutOutput({ stream });

      const exit = await Effect.runPromiseExit(
        output.send(createMessage({ toJSON: () => undefined })),
      );

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
        expect(exit.cause.error).toBeInstanceOf(StdoutOutputError);
        expect((exit.cause.error as StdoutOutputError).category).toBe(
          "logical",
        );
      }
      expect(chunks).toEqual([]);
    });
  });

  describe("newline delimiting and ordering", () => {
    it("writes each message as its own write, in call order", async () => {
      const { stream, chunks } = createMockStream();
      const output = createStdoutOutput({ stream });

      await Effect.runPromise(output.send(createMessage("a")));
      await Effect.runPromise(output.send(createMessage("b")));
      await Effect.runPromise(output.send(createMessage("c")));

      expect(chunks).toEqual(["a\n", "b\n", "c\n"]);
    });

    it("preserves message order under concurrent sends", async () => {
      const { stream, chunks } = createMockStream();
      const output = createStdoutOutput({ stream });

      const messages = Array.from({ length: 20 }, (_, i) =>
        createMessage(String(i)),
      );

      await Effect.runPromise(
        Effect.all(
          messages.map((m) => output.send(m)),
          { concurrency: "unbounded" },
        ),
      );

      expect(chunks).toEqual(messages.map((m) => `${m.content}\n`));
    });

    it("respects backpressure: concurrent sends wait for each write to actually flush", async () => {
      const { stream, chunks } = createMockStream({
        delayMs: 20,
        highWaterMark: 1,
      });
      const writeSpy = vi.spyOn(stream, "write");
      const output = createStdoutOutput({ stream });

      const start = Date.now();
      await Effect.runPromise(
        Effect.all(
          [output.send(createMessage("a")), output.send(createMessage("b"))],
          { concurrency: "unbounded" },
        ),
      );
      const elapsed = Date.now() - start;

      // Two 20ms writes serialized, not parallel: must take at least ~2x.
      expect(elapsed).toBeGreaterThanOrEqual(35);
      expect(writeSpy.mock.results.map((result) => result.value)).toEqual([
        false,
        false,
      ]);
      expect(chunks).toEqual(["a\n", "b\n"]);
    });
  });

  describe("write failures", () => {
    it("propagates a StdoutOutputError on write failure", async () => {
      const { stream, failNextWrite } = createMockStream();
      const output = createStdoutOutput({ stream });

      failNextWrite();

      await expect(
        Effect.runPromise(output.send(createMessage("boom"))),
      ).rejects.toThrow();
    });

    it("resumes writing subsequent messages after a transient failure", async () => {
      const { stream, chunks, failNextWrite } = createRecoverableStream();
      const output = createStdoutOutput({ stream });

      failNextWrite();
      await Effect.runPromise(
        output
          .send(createMessage("boom"))
          .pipe(Effect.catchAll(() => Effect.void)),
      );
      await Effect.runPromise(output.send(createMessage("recovered")));

      expect(chunks).toEqual(["recovered\n"]);
    });

    it("records send errors in metrics", async () => {
      const { stream, failNextWrite } = createMockStream();
      const output = createStdoutOutput({ stream });

      failNextWrite();
      await Effect.runPromise(
        output
          .send(createMessage("boom"))
          .pipe(Effect.catchAll(() => Effect.void)),
      );

      expect(output.getMetrics?.().sendErrors).toBe(1);
    });
  });

  describe("stream 'error' event handling", () => {
    it("does not raise an uncaughtException when a real write fails", async () => {
      const { stream, failNextWrite } = createMockStream();
      const output = createStdoutOutput({ stream });
      failNextWrite();

      const { uncaught } = await withUncaughtExceptionGuard(async () => {
        await Effect.runPromise(
          output
            .send(createMessage("boom"))
            .pipe(Effect.catchAll(() => Effect.void)),
        );
      });

      expect(uncaught).toEqual([]);
    });

    it("keeps failing cleanly (typed errors, no crash) after the stream auto-destroys", async () => {
      // Matches this environment's real process.stdout: autoDestroy defaults
      // to true, so one write failure permanently destroys the stream and
      // every later write also fails — the queue must keep surfacing typed
      // errors rather than hanging or crashing.
      const { stream, failNextWrite } = createMockStream();
      const output = createStdoutOutput({ stream });
      failNextWrite();

      const { uncaught } = await withUncaughtExceptionGuard(async () => {
        const first = await Effect.runPromiseExit(
          output.send(createMessage("boom")),
        );
        expect(first._tag).toBe("Failure");

        expect(stream.destroyed).toBe(true);

        const second = await Effect.runPromiseExit(
          output.send(createMessage("also fails cleanly")),
        );
        expect(second._tag).toBe("Failure");
        if (second._tag === "Failure" && second.cause._tag === "Fail") {
          expect(second.cause.error).toBeInstanceOf(StdoutOutputError);
          expect((second.cause.error as StdoutOutputError).category).toBe(
            "intermittent",
          );
        }
      });

      expect(uncaught).toEqual([]);
    });

    it("swallows a stray stream 'error' event with no write in flight", async () => {
      const { stream, chunks } = createMockStream();
      const output = createStdoutOutput({ stream });

      const { uncaught } = await withUncaughtExceptionGuard(async () => {
        stream.emit("error", new Error("idle failure, no write pending"));
      });

      expect(uncaught).toEqual([]);

      // The output itself should be unaffected — it never had a write to fail.
      await Effect.runPromise(output.send(createMessage("after-idle-error")));
      expect(chunks).toEqual(["after-idle-error\n"]);
    });

    it("removes only its own error listener on close, leaving external listeners intact", async () => {
      const { stream } = createMockStream();
      const externalListener = vi.fn();
      stream.on("error", externalListener);
      const listenersBefore = stream.listenerCount("error");

      const output = createStdoutOutput({ stream });
      expect(stream.listenerCount("error")).toBe(listenersBefore + 1);

      await Effect.runPromise(output.close!());

      expect(stream.listenerCount("error")).toBe(listenersBefore);
      expect(stream.listeners("error")).toContain(externalListener);
    });

    it("does not raise an uncaughtException when close() races a failing in-flight write", async () => {
      // close() waits for writeQueue (settled by the write callback) before
      // removeListener("error", ...) runs. A real Writable's destroy() emits
      // 'error' via process.nextTick, which resolves before the promise
      // microtask that resumes close() — so the listener is still attached
      // when the event lands. This test locks that ordering in.
      const stream = new Writable({
        write(_chunk, _encoding, callback) {
          setTimeout(() => callback(new Error("boom")), 5);
        },
      });
      const output = createStdoutOutput({ stream });

      const { uncaught } = await withUncaughtExceptionGuard(async () => {
        const sendPromise = Effect.runPromise(
          output
            .send(createMessage("x"))
            .pipe(Effect.catchAll(() => Effect.void)),
        );
        await Effect.runPromise(output.close!());
        await sendPromise;
      });

      expect(uncaught).toEqual([]);
    });
  });

  describe("metrics", () => {
    it("tracks messages sent", async () => {
      const { stream } = createMockStream();
      const output = createStdoutOutput({ stream });

      await Effect.runPromise(output.send(createMessage("a")));
      await Effect.runPromise(output.send(createMessage("b")));

      expect(output.getMetrics?.().messagesSent).toBe(2);
    });
  });

  describe("close", () => {
    it("does not end or destroy the underlying stream", async () => {
      const { stream } = createMockStream();
      const endSpy = vi.spyOn(stream, "end");
      const destroySpy = vi.spyOn(stream, "destroy");
      const output = createStdoutOutput({ stream });

      await Effect.runPromise(output.send(createMessage("a")));
      await Effect.runPromise(output.close!());

      expect(endSpy).not.toHaveBeenCalled();
      expect(destroySpy).not.toHaveBeenCalled();
    });

    it("waits for a genuinely pending write to flush before resolving", async () => {
      const { stream, chunks } = createMockStream({ delayMs: 20 });
      const output = createStdoutOutput({ stream });

      // send() has not resolved yet (write callback fires after delayMs);
      // close() must still wait for it rather than returning immediately.
      const sendPromise = Effect.runPromise(output.send(createMessage("a")));
      await Effect.runPromise(output.close!());
      await sendPromise;

      expect(chunks).toEqual(["a\n"]);
    });
  });

  describe("error type", () => {
    it("categorizes write failures as intermittent", async () => {
      const { stream, failNextWrite } = createMockStream();
      const output = createStdoutOutput({ stream });

      failNextWrite();

      const exit = await Effect.runPromiseExit(
        output.send(createMessage("boom")),
      );

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        const error = exit.cause as any;
        const failure = error.error ?? error;
        expect(failure).toBeInstanceOf(StdoutOutputError);
        expect(failure.category).toBe("intermittent");
      }
    });
  });
});
