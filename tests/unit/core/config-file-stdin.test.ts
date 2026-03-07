import { afterEach, describe, expect, it } from "vitest";
import { Effect } from "effect";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "../../../src/core/config-loader.js";
import { buildPipeline } from "../../../src/core/pipeline-builder.js";

const createdPaths: string[] = [];

const createTempDir = async (): Promise<string> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cascade-config-"));
  createdPaths.push(dir);
  return dir;
};

afterEach(async () => {
  await Promise.all(
    createdPaths.splice(0).map((target) =>
      fs.rm(target, { recursive: true, force: true }),
    ),
  );
});

describe("config-loader file/stdin registration", () => {
  it("loads and builds a pipeline with file input", async () => {
    const dir = await createTempDir();
    const inputPath = path.join(dir, "events.log");
    const configPath = path.join(dir, "file-pipeline.yaml");

    await fs.writeFile(inputPath, "seed\n", "utf8");
    await fs.writeFile(
      configPath,
      `input:
  file:
    path: "${inputPath.replace(/\\/g, "/")}"
    follow: false
    start_at: beginning
output:
  capture: {}
`,
      "utf8",
    );

    const config = await Effect.runPromise(loadConfig(configPath));
    const pipeline = await Effect.runPromise(buildPipeline(config));

    expect(pipeline.input.name).toBe("file-input");

    if (pipeline.input.close) {
      await Effect.runPromise(pipeline.input.close());
    }
  });

  it("loads and builds a pipeline with stdin input", async () => {
    const dir = await createTempDir();
    const configPath = path.join(dir, "stdin-pipeline.yaml");

    await fs.writeFile(
      configPath,
      `input:
  stdin:
    mode: lines
output:
  capture: {}
`,
      "utf8",
    );

    const config = await Effect.runPromise(loadConfig(configPath));
    const pipeline = await Effect.runPromise(buildPipeline(config));

    expect(pipeline.input.name).toBe("stdin-input");

    if (pipeline.input.close) {
      await Effect.runPromise(pipeline.input.close());
    }
  });
});
