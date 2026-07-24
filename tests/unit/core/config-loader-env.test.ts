import { afterEach, describe, expect, it } from "vitest";
import { Effect, Either } from "effect";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  ConfigValidationError,
  interpolateEnvVars,
  loadConfig,
} from "../../../src/core/config-loader.js";

const tempDirs: string[] = [];
const touchedEnvKeys = new Set<string>();
const originalEnv = new Map<string, string | undefined>();

const trackEnv = (key: string) => {
  if (!touchedEnvKeys.has(key)) {
    originalEnv.set(key, process.env[key]);
    touchedEnvKeys.add(key);
  }
};

const setEnv = (key: string, value: string) => {
  trackEnv(key);
  process.env[key] = value;
};

const clearEnv = (key: string) => {
  trackEnv(key);
  delete process.env[key];
};

const writeTempYaml = async (contents: string): Promise<string> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cascade-config-env-"));
  tempDirs.push(dir);
  const configPath = path.join(dir, "config.yaml");
  await fs.writeFile(configPath, contents, "utf8");
  return configPath;
};

afterEach(async () => {
  for (const key of touchedEnvKeys) {
    const previous = originalEnv.get(key);
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
  touchedEnvKeys.clear();
  originalEnv.clear();

  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("interpolateEnvVars", () => {
  it("substitutes required set values, including zero", () => {
    setEnv("CASCADE_TOKEN", "secret");
    setEnv("CASCADE_PORT", "0");

    expect(
      interpolateEnvVars({
        nested: {
          auth: "Bearer ${CASCADE_TOKEN}",
          port: "${CASCADE_PORT}",
          list: ["${CASCADE_TOKEN}", { deep: "${CASCADE_PORT}" }],
        },
      }),
    ).toEqual({
      nested: {
        auth: "Bearer secret",
        port: "0",
        list: ["secret", { deep: "0" }],
      },
    });
  });

  it("throws for missing required variables and names only the variable", () => {
    clearEnv("CASCADE_REQUIRED");

    expect(() => interpolateEnvVars("Bearer ${CASCADE_REQUIRED}")).toThrow(
      "Missing required environment variable: CASCADE_REQUIRED",
    );
  });

  it("throws for explicitly empty required variables", () => {
    setEnv("CASCADE_EMPTY", "");

    expect(() => interpolateEnvVars("${CASCADE_EMPTY}")).toThrow(
      "Missing required environment variable: CASCADE_EMPTY",
    );
  });

  it("supports explicit empty defaults with ${NAME:-}", () => {
    clearEnv("CASCADE_OPTIONAL");
    setEnv("CASCADE_EMPTY_OPTIONAL", "");

    expect(interpolateEnvVars("prefix-${CASCADE_OPTIONAL:-}-suffix")).toBe(
      "prefix--suffix",
    );
    expect(interpolateEnvVars("${CASCADE_EMPTY_OPTIONAL:-}")).toBe("");
  });

  it("supports ${NAME:-fallback} for unset/empty and prefers env values", () => {
    clearEnv("CASCADE_FALLBACK_UNSET");
    setEnv("CASCADE_FALLBACK_EMPTY", "");
    setEnv("CASCADE_FALLBACK_SET", "from-env");

    expect(interpolateEnvVars("${CASCADE_FALLBACK_UNSET:-fallback}")).toBe(
      "fallback",
    );
    expect(interpolateEnvVars("${CASCADE_FALLBACK_EMPTY:-fallback}")).toBe(
      "fallback",
    );
    expect(interpolateEnvVars("${CASCADE_FALLBACK_SET:-fallback}")).toBe(
      "from-env",
    );
  });

  it("throws a clear error for malformed expressions", () => {
    expect(() => interpolateEnvVars("${123INVALID}")).toThrow(
      "Invalid environment variable expression: ${123INVALID}",
    );
    expect(() => interpolateEnvVars("${BAD-NAME}")).toThrow(
      "Invalid environment variable expression: ${BAD-NAME}",
    );
    expect(() => interpolateEnvVars("${}")).toThrow(
      "Invalid environment variable expression: ${}",
    );
    expect(() => interpolateEnvVars("${UNCLOSED")).toThrow(
      "Invalid environment variable expression: ${UNCLOSED",
    );
    expect(() => interpolateEnvVars("${OUTER:-${INNER}}")).toThrow(
      "Invalid environment variable expression: ${OUTER:-${INNER}",
    );
    expect(() => interpolateEnvVars("${OUTER:-${INNER}")).toThrow(
      "Invalid environment variable expression: ${OUTER:-${INNER}",
    );
  });
});

describe("loadConfig environment interpolation", () => {
  it("returns ConfigValidationError naming MISSING_TOKEN for bearer auth", async () => {
    clearEnv("MISSING_TOKEN");

    const configPath = await writeTempYaml(`input:
  generate:
    count: 1
    template:
      value: test
output:
  http:
    url: "https://example.com/webhook"
    headers:
      Authorization: "Bearer \${MISSING_TOKEN}"
`);

    const result = await Effect.runPromise(Effect.either(loadConfig(configPath)));

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(ConfigValidationError);
      expect(result.left._tag).toBe("ConfigValidationError");
      expect(result.left.message).toContain(
        "Environment variable interpolation failed",
      );
      expect(result.left.message).toContain(
        "Missing required environment variable: MISSING_TOKEN",
      );
      expect(result.left.message).not.toMatch(/Bearer\s+\S+/);
    }
  });
});
