/**
 * Configuration file loading, interpolation, and schema delegation
 */
import { Effect, pipe } from "effect";
import * as Schema from "effect/Schema";
import * as yaml from "yaml";
import * as fs from "node:fs/promises";
import type { ComponentRegistry } from "./component-registry.js";
import {
  createPipelineConfigSchema,
  PipelineConfigEnvelopeSchema,
  type PipelineConfig,
} from "./config-schema.js";

export {
  PipelineConfigSchema,
  createPipelineConfigSchema,
  type PipelineConfig,
  type InputConfig,
  type OutputConfig,
  type ProcessorConfig,
} from "./config-schema.js";

export class FileReadError {
  readonly _tag = "FileReadError";
  constructor(
    readonly path: string,
    readonly cause: unknown,
  ) {}
}

export class YamlParseError {
  readonly _tag = "YamlParseError";
  constructor(
    readonly message: string,
    readonly cause?: unknown,
  ) {}
}

export class ConfigValidationError {
  readonly _tag = "ConfigValidationError";
  constructor(readonly message: string) {}
}

export const interpolateEnvVars = (value: unknown): unknown => {
  if (typeof value === "string") {
    return value.replace(
      /\$\{([^}]+)\}/g,
      (_, varName) => process.env[varName] || "",
    );
  }
  if (Array.isArray(value)) return value.map(interpolateEnvVars);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        interpolateEnvVars(entry),
      ]),
    );
  }
  return value;
};

const validationError = (error: unknown) =>
  new ConfigValidationError(`Schema validation failed: ${String(error)}`);

export const loadConfig = (
  path: string,
  registry?: ComponentRegistry,
): Effect.Effect<
  PipelineConfig,
  FileReadError | YamlParseError | ConfigValidationError
> =>
  Effect.gen(function* () {
    const content = yield* Effect.tryPromise({
      try: () => fs.readFile(path, "utf-8"),
      catch: (error) => new FileReadError(path, error),
    });
    const rawConfig = yield* Effect.try({
      try: () => yaml.parse(content),
      catch: (error) => new YamlParseError("Failed to parse YAML", error),
    });
    const interpolated = interpolateEnvVars(rawConfig);

    yield* pipe(
      Schema.decodeUnknown(PipelineConfigEnvelopeSchema, {
        onExcessProperty: "error",
      })(interpolated),
      Effect.mapError(validationError),
    );

    const schema = createPipelineConfigSchema(registry);
    const config = yield* pipe(
      Schema.decodeUnknown(schema)(interpolated),
      Effect.mapError(validationError),
    );
    return config as PipelineConfig;
  });
