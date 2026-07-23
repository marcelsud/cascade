import { afterEach, describe, it, expect } from "vitest";
import { Effect } from "effect";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  createFileOutput,
  FileOutputError,
} from "../../../src/outputs/file-output.js";
import { createMessage } from "../../../src/core/types.js";
import { loadConfig } from "../../../src/core/config-loader.js";
import { buildPipeline } from "../../../src/core/pipeline-builder.js";

const createdPaths: string[] = [];
const createTempDir = async (): Promise<string> => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "cascade-file-out-"));
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

const send = (output: ReturnType<typeof createFileOutput>, content: unknown) =>
  Effect.runPromise(output.send(createMessage(content as any)));

const sendExit = (
  output: ReturnType<typeof createFileOutput>,
  content: unknown,
) => Effect.runPromiseExit(output.send(createMessage(content as any)));

describe("FileOutput", () => {
  describe("configuration validation", () => {
    it("rejects an empty path", () => {
      expect(() => createFileOutput({ path: "" })).toThrow();
    });

    it("rejects an invalid format", async () => {
      const dir = await createTempDir();
      expect(() =>
        createFileOutput({
          path: path.join(dir, "x.ndjson"),
          format: "invalid" as any,
        }),
      ).toThrow();
    });

    it("rejects an invalid mode", async () => {
      const dir = await createTempDir();
      expect(() =>
        createFileOutput({
          path: path.join(dir, "x.ndjson"),
          mode: "truncate" as any,
        }),
      ).toThrow();
    });
  });

  describe("construction-time parent validation (no fs mutation)", () => {
    it("fails fatally when the parent directory does not exist, creating nothing", async () => {
      const dir = await createTempDir();
      const missingParent = path.join(dir, "does-not-exist");
      const target = path.join(missingParent, "x.ndjson");

      expect(() => createFileOutput({ path: target })).toThrow(FileOutputError);
      try {
        createFileOutput({ path: target });
      } catch (error) {
        expect((error as FileOutputError).category).toBe("fatal");
      }
      expect(fs.existsSync(missingParent)).toBe(false);
    });

    it("does not create or truncate the target during construction", async () => {
      const dir = await createTempDir();
      const target = path.join(dir, "lazy.ndjson");

      createFileOutput({ path: target });

      expect(fs.existsSync(target)).toBe(false);
    });
  });

  describe("YAML pipeline build", () => {
    it("loads and builds a pipeline with file output", async () => {
      const dir = await createTempDir();
      const configPath = path.join(dir, "pipeline.yaml");
      await fsp.writeFile(
        configPath,
        `input:
  generate:
    count: 1
    template: { value: "test" }
output:
  file:
    path: "${path.join(dir, "out.ndjson")}"
    format: message
    mode: overwrite
`,
        "utf8",
      );

      const config = await Effect.runPromise(loadConfig(configPath));
      const pipeline = await Effect.runPromise(buildPipeline(config));

      expect(pipeline.output.name).toBe("file-output");
      // Building must not open the file.
      expect(fs.existsSync(path.join(dir, "out.ndjson"))).toBe(false);

      if (pipeline.output.close) {
        await Effect.runPromise(pipeline.output.close());
      }
    });

    it("builds a pipeline using file output as a DLQ destination", async () => {
      const dir = await createTempDir();
      const configPath = path.join(dir, "dlq-pipeline.yaml");
      await fsp.writeFile(
        configPath,
        `input:
  generate:
    count: 1
    template: { value: "test" }
output:
  stdout: {}
dlq:
  output:
    file:
      path: "${path.join(dir, "dlq.ndjson")}"
  max_retries: 1
`,
        "utf8",
      );

      const config = await Effect.runPromise(loadConfig(configPath));
      // Succeeds only if the file DLQ output was constructed (bad parent
      // would fail the build), exercising the primary-or-DLQ contract.
      const pipeline = await Effect.runPromise(buildPipeline(config));
      expect(pipeline.output).toBeDefined();

      if (pipeline.output.close) {
        await Effect.runPromise(pipeline.output.close());
      }
    });
  });

  describe("append mode (default)", () => {
    it("creates a missing target file on first send", async () => {
      const dir = await createTempDir();
      const target = path.join(dir, "created.ndjson");
      const output = createFileOutput({ path: target });

      await send(output, "hello");
      await Effect.runPromise(output.close!());

      expect(await fsp.readFile(target, "utf8")).toBe("hello\n");
    });

    it("appends to an existing file without truncating it", async () => {
      const dir = await createTempDir();
      const target = path.join(dir, "existing.ndjson");
      await fsp.writeFile(target, "seed\n", "utf8");

      const output = createFileOutput({ path: target, mode: "append" });
      await send(output, "added");
      await Effect.runPromise(output.close!());

      expect(await fsp.readFile(target, "utf8")).toBe("seed\nadded\n");
    });
  });

  describe("overwrite mode", () => {
    it("truncates once on first send, then appends subsequent records", async () => {
      const dir = await createTempDir();
      const target = path.join(dir, "over.ndjson");
      await fsp.writeFile(target, "old-content\n", "utf8");

      const output = createFileOutput({ path: target, mode: "overwrite" });
      await send(output, "first");
      await send(output, "second");
      await Effect.runPromise(output.close!());

      expect(await fsp.readFile(target, "utf8")).toBe("first\nsecond\n");
    });

    it("leaves existing content untouched on a zero-message run", async () => {
      const dir = await createTempDir();
      const target = path.join(dir, "untouched.ndjson");
      await fsp.writeFile(target, "keep-me\n", "utf8");

      const output = createFileOutput({ path: target, mode: "overwrite" });
      // No send() — lazy open must never fire, so no truncation.
      await Effect.runPromise(output.close!());

      expect(await fsp.readFile(target, "utf8")).toBe("keep-me\n");
    });
  });

  describe("record encoding", () => {
    it("writes structured content as one JSON line per message", async () => {
      const dir = await createTempDir();
      const target = path.join(dir, "json.ndjson");
      const output = createFileOutput({ path: target });

      await send(output, { a: 1 });
      await send(output, { b: 2 });
      await Effect.runPromise(output.close!());

      const lines = (await fsp.readFile(target, "utf8"))
        .split("\n")
        .filter(Boolean);
      expect(lines.map((l) => JSON.parse(l))).toEqual([{ a: 1 }, { b: 2 }]);
    });

    it("preserves raw multiline string content in content format", async () => {
      const dir = await createTempDir();
      const target = path.join(dir, "multiline.ndjson");
      const output = createFileOutput({ path: target, format: "content" });

      await send(output, "first\nsecond");
      await Effect.runPromise(output.close!());

      expect(await fsp.readFile(target, "utf8")).toBe("first\nsecond\n");
    });

    it("keeps each message on a single physical line in message format", async () => {
      const dir = await createTempDir();
      const target = path.join(dir, "envelope.ndjson");
      const output = createFileOutput({ path: target, format: "message" });

      await send(output, "a\nb");
      await Effect.runPromise(output.close!());

      const lines = (await fsp.readFile(target, "utf8"))
        .split("\n")
        .filter(Boolean);
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]).content).toBe("a\nb");
    });
  });

  describe("concurrent ordering and flush-on-close", () => {
    it("writes concurrent sends in call order and flushes on close", async () => {
      const dir = await createTempDir();
      const target = path.join(dir, "ordered.ndjson");
      const output = createFileOutput({ path: target });

      await Effect.runPromise(
        Effect.all(
          Array.from({ length: 25 }, (_, i) =>
            output.send(createMessage(String(i))),
          ),
          { concurrency: "unbounded" },
        ),
      );
      await Effect.runPromise(output.close!());

      const lines = (await fsp.readFile(target, "utf8"))
        .split("\n")
        .filter(Boolean);
      expect(lines).toEqual(Array.from({ length: 25 }, (_, i) => String(i)));
    });
  });

  describe("error categories", () => {
    it("reports serialization failures as logical, writing nothing", async () => {
      const dir = await createTempDir();
      const target = path.join(dir, "serialize.ndjson");
      const output = createFileOutput({ path: target });

      const exit = await sendExit(output, undefined);
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
        expect(exit.cause.error).toBeInstanceOf(FileOutputError);
        expect((exit.cause.error as FileOutputError).category).toBe("logical");
      }
      expect(output.getMetrics?.().sendErrors).toBe(1);
      // Serialization failed before any open: no file created.
      expect(fs.existsSync(target)).toBe(false);
    });

    it("reports an invalid path (directory target) as fatal, mutating nothing", async () => {
      const dir = await createTempDir();
      const subdir = path.join(dir, "target-dir");
      await fsp.mkdir(subdir);

      // Parent (dir) exists, so construction passes; the directory target
      // fails to open (EISDIR) at first send.
      const output = createFileOutput({ path: subdir });
      const exit = await sendExit(output, "x");

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
        expect(exit.cause.error).toBeInstanceOf(FileOutputError);
        expect((exit.cause.error as FileOutputError).category).toBe("fatal");
      }
      // The directory is still a directory — nothing was written into it.
      expect((await fsp.stat(subdir)).isDirectory()).toBe(true);
      expect(await fsp.readdir(subdir)).toEqual([]);
    });

    it.runIf(fs.existsSync("/dev/full"))(
      "reports a post-open write failure as intermittent",
      async () => {
        // /dev/full opens cleanly but every write fails with ENOSPC — a real,
        // deterministic write-phase (post-'open') failure.
        const output = createFileOutput({ path: "/dev/full", mode: "append" });
        const exit = await sendExit(output, "x");

        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
          expect(exit.cause.error).toBeInstanceOf(FileOutputError);
          expect((exit.cause.error as FileOutputError).category).toBe(
            "intermittent",
          );
        }
      },
    );
  });

  describe("metrics", () => {
    it("tracks messages sent", async () => {
      const dir = await createTempDir();
      const target = path.join(dir, "metrics.ndjson");
      const output = createFileOutput({ path: target });

      await send(output, "a");
      await send(output, "b");
      await Effect.runPromise(output.close!());

      expect(output.getMetrics?.().messagesSent).toBe(2);
    });
  });
});
