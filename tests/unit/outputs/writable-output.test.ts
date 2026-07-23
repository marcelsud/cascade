import { afterEach, describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Writable } from "node:stream";
import { EventEmitter } from "node:events";
import {
  serializeMessage,
  createWriteCoordinator,
  StreamWriteError,
} from "../../../src/outputs/writable-output.js";
import { createMessage } from "../../../src/core/types.js";

/**
 * A real node:stream Writable that emits BOTH the write() callback and an
 * 'error' event on failure — the dual signal the coordinator must reconcile.
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
 * EventEmitter-backed Writable stand-in that mirrors a real stream's dual
 * failure signal but stays usable after a failure, isolating "does the write
 * queue recover" from Node stream-internals wedging.
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

const createdPaths: string[] = [];
const createTempDir = async (): Promise<string> => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "cascade-writable-"));
  createdPaths.push(dir);
  return dir;
};

afterEach(async () => {
  await Promise.all(
    createdPaths
      .splice(0)
      .map((target) => fsp.rm(target, { recursive: true, force: true })),
  );
});

describe("serializeMessage", () => {
  describe("content format", () => {
    it("writes string content raw, not JSON-encoded", () => {
      expect(serializeMessage(createMessage("hello"), "content")).toBe("hello");
    });

    it("preserves raw multiline strings exactly", () => {
      expect(serializeMessage(createMessage("a\nb"), "content")).toBe("a\nb");
    });

    it("JSON-serializes non-string content", () => {
      expect(serializeMessage(createMessage({ a: 1 }), "content")).toBe(
        JSON.stringify({ a: 1 }),
      );
    });

    it("throws on undefined root content instead of writing 'undefined'", () => {
      expect(() =>
        serializeMessage(createMessage(undefined as any), "content"),
      ).toThrow();
    });

    it("throws on circular content", () => {
      const circular: any = {};
      circular.self = circular;
      expect(() =>
        serializeMessage(createMessage(circular), "content"),
      ).toThrow();
    });

    it("throws when root toJSON returns undefined", () => {
      expect(() =>
        serializeMessage(createMessage({ toJSON: () => undefined }), "content"),
      ).toThrow();
    });
  });

  describe("message format", () => {
    it("emits a single physical line for multiline string content", () => {
      const line = serializeMessage(createMessage("a\nb"), "message");
      expect(line.split("\n")).toHaveLength(1);
      expect(JSON.parse(line).content).toBe("a\nb");
    });

    it("preserves normal JSON semantics for nested undefined fields", () => {
      const line = serializeMessage(
        createMessage({ keep: "yes", drop: undefined }),
        "message",
      );
      expect(JSON.parse(line).content).toEqual({ keep: "yes" });
    });

    it("rejects unrepresentable root content (undefined/function/symbol)", () => {
      for (const bad of [undefined, () => {}, Symbol("x")]) {
        expect(() =>
          serializeMessage(createMessage(bad as any), "message"),
        ).toThrow();
      }
    });

    it("rejects BigInt content", () => {
      expect(() =>
        serializeMessage(createMessage(10n as any), "message"),
      ).toThrow();
    });
  });
});

describe("createWriteCoordinator (borrowed stream)", () => {
  it("appends a newline and writes in call order", async () => {
    const { stream, chunks } = createMockStream();
    const c = createWriteCoordinator({ stream });

    await c.write("a");
    await c.write("b");

    expect(chunks).toEqual(["a\n", "b\n"]);
  });

  it("preserves order under concurrent writes", async () => {
    const { stream, chunks } = createMockStream();
    const c = createWriteCoordinator({ stream });

    await Promise.all(Array.from({ length: 20 }, (_, i) => c.write(String(i))));

    expect(chunks).toEqual(Array.from({ length: 20 }, (_, i) => `${i}\n`));
  });

  it("respects backpressure: concurrent writes serialize", async () => {
    const { stream, chunks } = createMockStream({
      delayMs: 20,
      highWaterMark: 1,
    });
    const writeSpy = vi.spyOn(stream, "write");
    const c = createWriteCoordinator({ stream });

    const start = Date.now();
    await Promise.all([c.write("a"), c.write("b")]);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(35);
    expect(writeSpy.mock.results.map((r) => r.value)).toEqual([false, false]);
    expect(chunks).toEqual(["a\n", "b\n"]);
  });

  it("rejects a failed write with a StreamWriteError of phase 'write'", async () => {
    const { stream, failNextWrite } = createMockStream();
    const c = createWriteCoordinator({ stream });
    failNextWrite();

    const error = await c.write("boom").catch((e) => e);
    expect(error).toBeInstanceOf(StreamWriteError);
    expect((error as StreamWriteError).phase).toBe("write");
  });

  it("recovers and keeps writing after a transient failure", async () => {
    const { stream, chunks, failNextWrite } = createRecoverableStream();
    const c = createWriteCoordinator({ stream });

    failNextWrite();
    await c.write("boom").catch(() => undefined);
    await c.write("recovered");

    expect(chunks).toEqual(["recovered\n"]);
  });

  it("swallows a stray 'error' event with no write in flight", async () => {
    const { stream, chunks } = createMockStream();
    const c = createWriteCoordinator({ stream });

    const uncaught: Error[] = [];
    const handler = (e: Error) => uncaught.push(e);
    process.on("uncaughtException", handler);
    try {
      stream.emit("error", new Error("idle failure"));
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      process.removeListener("uncaughtException", handler);
    }

    expect(uncaught).toEqual([]);
    await c.write("after-idle");
    expect(chunks).toEqual(["after-idle\n"]);
  });

  it("close() detaches only its own listener and never ends the stream", async () => {
    const { stream } = createMockStream();
    const external = vi.fn();
    stream.on("error", external);
    const before = stream.listenerCount("error");
    const endSpy = vi.spyOn(stream, "end");

    const c = createWriteCoordinator({ stream });
    expect(stream.listenerCount("error")).toBe(before + 1);

    await c.write("a");
    await c.close();

    expect(stream.listenerCount("error")).toBe(before);
    expect(stream.listeners("error")).toContain(external);
    expect(endSpy).not.toHaveBeenCalled();
  });
});

describe("createWriteCoordinator (owned stream)", () => {
  it("does not open the stream until the first write", () => {
    const open = vi.fn(() => fs.createWriteStream(path.join(os.tmpdir(), "x")));
    createWriteCoordinator({ owned: true, open });
    expect(open).not.toHaveBeenCalled();
    // Never written -> nothing to clean up; drop the unused handle.
    open.mockClear();
  });

  it("close() creates nothing and never opens when no writes happened", async () => {
    const dir = await createTempDir();
    const filePath = path.join(dir, "never.ndjson");
    const open = vi.fn(() => fs.createWriteStream(filePath));
    const c = createWriteCoordinator({ owned: true, open });

    await c.close();

    expect(open).not.toHaveBeenCalled();
    await expect(fsp.stat(filePath)).rejects.toThrow();
  });

  it("opens lazily, writes in order, and flushes on close", async () => {
    const dir = await createTempDir();
    const filePath = path.join(dir, "out.ndjson");
    const open = vi.fn(() => fs.createWriteStream(filePath));
    const c = createWriteCoordinator({ owned: true, open });

    await c.write("a");
    expect(open).toHaveBeenCalledTimes(1);
    await c.write("b");
    await c.close();

    expect(await fsp.readFile(filePath, "utf8")).toBe("a\nb\n");
  });

  it("surfaces an open failure as a StreamWriteError of phase 'open'", async () => {
    const dir = await createTempDir();
    // A directory target fails to open (EISDIR) via an async 'error' event.
    const c = createWriteCoordinator({
      owned: true,
      open: () => fs.createWriteStream(dir),
    });

    const error = await c.write("x").catch((e) => e);
    expect(error).toBeInstanceOf(StreamWriteError);
    expect((error as StreamWriteError).phase).toBe("open");
  });
});
