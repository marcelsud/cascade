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

const ENV_VAR_EXPRESSION = /^([A-Za-z_][A-Za-z0-9_]*)(:-(.*))?$/;

const resolveEnvExpression = (expression: string): string => {
  if (expression.includes("${")) {
    throw new Error(
      `Invalid environment variable expression: \${${expression}}`,
    );
  }

  const match = ENV_VAR_EXPRESSION.exec(expression);
  if (!match) {
    throw new Error(
      `Invalid environment variable expression: \${${expression}}`,
    );
  }

  const [, name, defaultClause, defaultValue = ""] = match;
  const envValue = process.env[name];

  if (envValue !== undefined && envValue !== "") {
    return envValue;
  }

  if (defaultClause !== undefined) {
    return defaultValue;
  }

  throw new Error(`Missing required environment variable: ${name}`);
};

const interpolateString = (input: string): string => {
  let result = "";
  let cursor = 0;

  while (cursor < input.length) {
    const open = input.indexOf("${", cursor);
    if (open === -1) {
      result += input.slice(cursor);
      break;
    }

    result += input.slice(cursor, open);
    const close = input.indexOf("}", open + 2);
    if (close === -1) {
      throw new Error(
        `Invalid environment variable expression: ${input.slice(open)}`,
      );
    }

    result += resolveEnvExpression(input.slice(open + 2, close));
    cursor = close + 1;
  }

  return result;
};

export const interpolateEnvVars = (value: unknown): unknown => {
  if (typeof value === "string") {
    return interpolateString(value);
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
    const interpolated = yield* Effect.try({
      try: () => interpolateEnvVars(rawConfig),
      catch: (error) =>
        new ConfigValidationError(
          `Environment variable interpolation failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
    });

    yield* pipe(
      Schema.decodeUnknown(PipelineConfigEnvelopeSchema, {
        onExcessProperty: "error",
      })(interpolated),
      Effect.mapError(validationError),
    );

    const schema = yield* Effect.try({
      try: () => createPipelineConfigSchema(registry),
      catch: (error) => new ConfigValidationError(String(error)),
    });
    const config = yield* pipe(
      Schema.decodeUnknown(schema)(interpolated),
      Effect.mapError(validationError),
    );
    return config as PipelineConfig;
  });
