import { afterEach, describe, expect, it } from "vitest";
import { Effect, Either } from "effect";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as yaml from "yaml";
import { validateConfig } from "../../src/cli-config.js";

const tempDirs: string[] = [];

const writeConfig = async (config: unknown): Promise<string> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cascade-validate-"));
  tempDirs.push(dir);
  const configPath = path.join(dir, "pipeline.yaml");
  await fs.writeFile(configPath, yaml.stringify(config), "utf8");
  return configPath;
};

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true })),
  );
});

describe("CLI config validation", () => {
  it("builds a valid config and returns its component summary", async () => {
    const configPath = await writeConfig({
      input: { generate: { count: 1, template: { value: "test" } } },
      pipeline: { processors: [{ uppercase: { fields: ["value"] } }] },
      output: { capture: {} },
      dlq: { output: { capture: {} }, max_retries: 0 },
    });

    const summary = await Effect.runPromise(validateConfig(configPath));

    expect(summary).toEqual({
      input: "generate",
      processors: ["uppercase"],
      output: "capture",
      dlq: true,
    });
  });

  it("returns invalid configuration through the error channel", async () => {
    const configPath = await writeConfig({
      input: { generate: { count: 0, template: {} } },
      output: { capture: {} },
    });

    const result = await Effect.runPromise(
      Effect.either(validateConfig(configPath)),
    );

    expect(Either.isLeft(result)).toBe(true);
  });
});
