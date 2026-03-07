/**
 * Configuration loader and validator using Effect Schema
 */
import { Effect, pipe } from "effect";
import * as S from "effect/Schema";
import * as yaml from "yaml";
import * as fs from "node:fs/promises";

/**
 * Custom errors for config loading
 */
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

/**
 * Schema for AWS SQS Input configuration (Bento style)
 */
const AwsSqsInputSchema = S.Struct({
  url: S.String,
  region: S.optional(S.String),
  endpoint: S.optional(S.String),
  wait_time_seconds: S.optional(S.Number),
  max_number_of_messages: S.optional(S.Number),
});

/**
 * Schema for Redis Streams Input configuration (Bento style)
 */
const RedisStreamsInputSchema = S.Struct({
  url: S.String, // redis://host:port format
  stream: S.String,
  mode: S.optional(S.Union(S.Literal("simple"), S.Literal("consumer-group"))),
  consumer_group: S.optional(S.String),
  consumer_name: S.optional(S.String),
  block_ms: S.optional(S.Number),
  count: S.optional(S.Number),
  start_id: S.optional(S.String),
});

/**
 * Schema for HTTP Input configuration (Bento style)
 */
const HttpInputSchema = S.Struct({
  port: S.Number,
  host: S.optional(S.String),
  path: S.optional(S.String),
  timeout: S.optional(S.Number),
});

/**
 * Schema for File Input configuration
 */
const FileInputSchema = S.Struct({
  path: S.String,
  follow: S.optional(S.Boolean),
  start_at: S.optional(S.Union(S.Literal("end"), S.Literal("beginning"))),
  poll_interval_ms: S.optional(S.Number),
  encoding: S.optional(S.String),
});

/**
 * Schema for Stdin Input configuration
 */
const StdinInputSchema = S.Struct({
  mode: S.optional(S.Union(S.Literal("lines"), S.Literal("whole"))),
  encoding: S.optional(S.String),
});

/**
 * Schema for Redis Pub/Sub Input configuration (Bento style)
 */
const RedisPubSubInputSchema = S.Struct({
  host: S.String,
  port: S.Number,
  password: S.optional(S.String),
  db: S.optional(S.Number),
  channels: S.optional(S.Array(S.String)),
  patterns: S.optional(S.Array(S.String)),
  queue_size: S.optional(S.Number),
  connect_timeout: S.optional(S.Number),
  command_timeout: S.optional(S.Number),
  keep_alive: S.optional(S.Number),
  lazy_connect: S.optional(S.Boolean),
  max_retries_per_request: S.optional(S.Number),
  enable_offline_queue: S.optional(S.Boolean),
});

/**
 * Schema for Redis List Input configuration (Bento style)
 */
const RedisListInputSchema = S.Struct({
  host: S.String,
  port: S.Number,
  key: S.Union(S.String, S.Array(S.String)),
  password: S.optional(S.String),
  db: S.optional(S.Number),
  direction: S.optional(S.Union(S.Literal("left"), S.Literal("right"))),
  timeout: S.optional(S.Number),
  connect_timeout: S.optional(S.Number),
  command_timeout: S.optional(S.Number),
  keep_alive: S.optional(S.Number),
  lazy_connect: S.optional(S.Boolean),
  max_retries_per_request: S.optional(S.Number),
  enable_offline_queue: S.optional(S.Boolean),
});

/**
 * Schema for Generate Input (testing utility)
 */
const GenerateInputSchema = S.Struct({
  count: S.Int.pipe(S.positive()),
  interval: S.optional(S.Int.pipe(S.nonNegative())),
  template: S.Record({ key: S.String, value: S.Unknown }),
  start_index: S.optional(S.Int.pipe(S.nonNegative())),
});

/**
 * Input configuration - detects type by key
 */
const InputConfigSchema = S.Struct({
  aws_sqs: S.optional(AwsSqsInputSchema),
  redis_streams: S.optional(RedisStreamsInputSchema),
  redis_pubsub: S.optional(RedisPubSubInputSchema),
  redis_list: S.optional(RedisListInputSchema),
  http: S.optional(HttpInputSchema),
  file: S.optional(FileInputSchema),
  stdin: S.optional(StdinInputSchema),
  generate: S.optional(GenerateInputSchema),
  // Future inputs can be added here:
  // kafka: S.optional(KafkaInputSchema),
});

/**
 * Schema for Metadata Processor (Bento style)
 */
const MetadataProcessorSchema = S.Struct({
  correlation_id_field: S.optional(S.String),
  add_timestamp: S.optional(S.Boolean),
});

/**
 * Schema for Uppercase Processor (Bento style)
 */
const UppercaseProcessorSchema = S.Struct({
  fields: S.Array(S.String),
});

/**
 * Schema for Logging Processor (Bento style)
 */
const LogProcessorSchema = S.Struct({
  level: S.optional(
    S.Union(
      S.Literal("debug"),
      S.Literal("info"),
      S.Literal("warn"),
      S.Literal("error"),
    ),
  ),
  include_content: S.optional(S.Boolean),
});

/**
 * Schema for Mapping Processor (JSONata-based transformations)
 */
const MappingProcessorSchema = S.Struct({
  expression: S.String,
});

/**
 * Schema for HTTP Processor (API enrichment and validation)
 */
const HttpProcessorSchema = S.Struct({
  url: S.String,
  method: S.optional(
    S.Union(
      S.Literal("GET"),
      S.Literal("POST"),
      S.Literal("PUT"),
      S.Literal("PATCH"),
    ),
  ),
  headers: S.optional(S.Record({ key: S.String, value: S.String })),
  body: S.optional(S.String),
  result_key: S.optional(S.String),
  result_mapping: S.optional(S.String),
  timeout: S.optional(S.Number),
  max_retries: S.optional(S.Number),
  auth: S.optional(
    S.Struct({
      type: S.Union(S.Literal("basic"), S.Literal("bearer")),
      username: S.optional(S.String),
      password: S.optional(S.String),
      token: S.optional(S.String),
    }),
  ),
});

/**
 * Schema for Dedupe Processor (attribute-based deduplication)
 */
const DedupeProcessorSchema = S.Struct({
  key: S.String.pipe(
    S.minLength(1, {
      message: () =>
        "Dedupe processor 'key' must be a non-empty string (e.g. 'messageId' or 'metadata.correlationId')",
    }),
  ),
  window_ms: S.optional(
    S.Number.pipe(
      S.positive({
        message: () =>
          "Dedupe processor 'window_ms' must be a positive number (milliseconds)",
      }),
    ),
  ),
  max_keys: S.optional(
    S.Number.pipe(
      S.int({
        message: () => "Dedupe processor 'max_keys' must be an integer",
      }),
      S.positive({
        message: () =>
          "Dedupe processor 'max_keys' must be a positive integer",
      }),
    ),
  ),
});

/**
 * Schema for Assert Processor (testing utility)
 */
const AssertProcessorSchema = S.Struct({
  expression: S.String,
  expected: S.Unknown,
});

/**
 * Processor configuration - recursive to support nested processors (branch, switch)
 * Uses S.suspend for recursive schema definition
 */
interface ProcessorConfigSchema extends S.Schema<ProcessorConfig> {}
const ProcessorConfigSchema: ProcessorConfigSchema = S.suspend(
  (): S.Schema<ProcessorConfig> =>
    S.Struct({
      metadata: S.optional(MetadataProcessorSchema),
      uppercase: S.optional(UppercaseProcessorSchema),
      log: S.optional(LogProcessorSchema),
      mapping: S.optional(MappingProcessorSchema),
      http: S.optional(HttpProcessorSchema),
      branch: S.optional(
        S.Struct({
          processors: S.Array(S.suspend(() => ProcessorConfigSchema)),
        }),
      ),
      switch: S.optional(
        S.Struct({
          cases: S.Array(
            S.Struct({
              check: S.String,
              processors: S.Array(S.suspend(() => ProcessorConfigSchema)),
            }),
          ),
        }),
      ),
      dedupe: S.optional(DedupeProcessorSchema),
      // Testing utilities
      assert: S.optional(AssertProcessorSchema),
    }),
);

/**
 * Schema for Redis Streams Output (Bento style)
 */
const RedisStreamsOutputSchema = S.Struct({
  url: S.String,
  stream: S.String,
  max_length: S.optional(S.Number),
});

/**
 * Schema for AWS SQS Output configuration (Bento style)
 */
const AwsSqsOutputSchema = S.Struct({
  url: S.String,
  region: S.optional(S.String),
  endpoint: S.optional(S.String),
  max_batch_size: S.optional(S.Number),
  delay_seconds: S.optional(S.Number),
});

/**
 * Schema for HTTP Output configuration (Bento style)
 */
const HttpOutputSchema = S.Struct({
  url: S.String,
  method: S.optional(
    S.Union(S.Literal("POST"), S.Literal("PUT"), S.Literal("PATCH")),
  ),
  headers: S.optional(S.Record({ key: S.String, value: S.String })),
  timeout: S.optional(S.Number),
  max_retries: S.optional(S.Number),
  auth: S.optional(
    S.Struct({
      type: S.Union(S.Literal("basic"), S.Literal("bearer")),
      username: S.optional(S.String),
      password: S.optional(S.String),
      token: S.optional(S.String),
    }),
  ),
});

/**
 * Schema for Redis Pub/Sub Output configuration (Bento style)
 */
const RedisPubSubOutputSchema = S.Struct({
  host: S.String,
  port: S.Number,
  channel: S.String,
  password: S.optional(S.String),
  db: S.optional(S.Number),
  max_retries: S.optional(S.Number),
  connect_timeout: S.optional(S.Number),
  command_timeout: S.optional(S.Number),
  keep_alive: S.optional(S.Number),
  lazy_connect: S.optional(S.Boolean),
  max_retries_per_request: S.optional(S.Number),
  enable_offline_queue: S.optional(S.Boolean),
});

/**
 * Schema for Redis List Output configuration (Bento style)
 */
const RedisListOutputSchema = S.Struct({
  host: S.String,
  port: S.Number,
  key: S.String,
  password: S.optional(S.String),
  db: S.optional(S.Number),
  direction: S.optional(S.Union(S.Literal("left"), S.Literal("right"))),
  max_length: S.optional(S.Number),
  max_retries: S.optional(S.Number),
  connect_timeout: S.optional(S.Number),
  command_timeout: S.optional(S.Number),
  keep_alive: S.optional(S.Number),
  lazy_connect: S.optional(S.Boolean),
  max_retries_per_request: S.optional(S.Number),
  enable_offline_queue: S.optional(S.Boolean),
});

/**
 * Schema for Capture Output (testing utility)
 */
const CaptureOutputSchema = S.Struct({
  max_messages: S.optional(S.Number),
});

/**
 * Output configuration - detects type by key
 */
const OutputConfigSchema = S.Struct({
  redis_streams: S.optional(RedisStreamsOutputSchema),
  redis_pubsub: S.optional(RedisPubSubOutputSchema),
  redis_list: S.optional(RedisListOutputSchema),
  aws_sqs: S.optional(AwsSqsOutputSchema),
  http: S.optional(HttpOutputSchema),
  capture: S.optional(CaptureOutputSchema),
  // Future outputs can be added here:
  // postgres: S.optional(PostgresOutputSchema),
});

/**
 * Complete pipeline configuration schema (Bento style)
 */
export const PipelineConfigSchema = S.Struct({
  input: InputConfigSchema,
  pipeline: S.optional(
    S.Struct({
      processors: S.optional(S.Array(ProcessorConfigSchema)),
    }),
  ),
  output: OutputConfigSchema,
});

/**
 * TypeScript type inferred from schema
 */
export type PipelineConfig = S.Schema.Type<typeof PipelineConfigSchema>;
export type InputConfig = S.Schema.Type<typeof InputConfigSchema>;
export type OutputConfig = S.Schema.Type<typeof OutputConfigSchema>;

/**
 * ProcessorConfig type - manually defined as recursive
 */
export type ProcessorConfig = {
  readonly metadata?: {
    readonly correlation_id_field?: string;
    readonly add_timestamp?: boolean;
  };
  readonly uppercase?: {
    readonly fields: readonly string[];
  };
  readonly log?: {
    readonly level?: "debug" | "info" | "warn" | "error";
    readonly include_content?: boolean;
  };
  readonly mapping?: {
    readonly expression: string;
  };
  readonly http?: {
    readonly url: string;
    readonly method?: "GET" | "POST" | "PUT" | "PATCH";
    readonly headers?: Record<string, string>;
    readonly body?: string;
    readonly result_key?: string;
    readonly result_mapping?: string;
    readonly timeout?: number;
    readonly max_retries?: number;
    readonly auth?: {
      readonly type: "basic" | "bearer";
      readonly username?: string;
      readonly password?: string;
      readonly token?: string;
    };
  };
  readonly branch?: {
    readonly processors: readonly ProcessorConfig[];
  };
  readonly switch?: {
    readonly cases: readonly {
      readonly check: string;
      readonly processors: readonly ProcessorConfig[];
    }[];
  };
  readonly dedupe?: {
    readonly key: string;
    readonly window_ms?: number;
    readonly max_keys?: number;
  };
  // Testing utilities
  readonly assert?: {
    readonly expression: string;
    readonly expected: unknown;
  };
};

/**
 * Interpolate environment variables in strings
 * Supports ${VAR_NAME} syntax
 */
export const interpolateEnvVars = (value: unknown): unknown => {
  if (typeof value === "string") {
    return value.replace(/\$\{([^}]+)\}/g, (_, varName) => {
      return process.env[varName] || "";
    });
  }

  if (Array.isArray(value)) {
    return value.map(interpolateEnvVars);
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, interpolateEnvVars(v)]),
    );
  }

  return value;
};

/**
 * Load and parse YAML configuration file
 */
export const loadConfig = (
  path: string,
): Effect.Effect<
  PipelineConfig,
  FileReadError | YamlParseError | ConfigValidationError
> => {
  return Effect.gen(function* () {
    // Read file
    const content = yield* Effect.tryPromise({
      try: () => fs.readFile(path, "utf-8"),
      catch: (error) => new FileReadError(path, error),
    });

    // Parse YAML
    const rawConfig = yield* Effect.try({
      try: () => yaml.parse(content),
      catch: (error) => new YamlParseError("Failed to parse YAML", error),
    });

    // Interpolate environment variables
    const interpolated = interpolateEnvVars(rawConfig);

    // Validate with schema
    const config = yield* pipe(
      S.decodeUnknown(PipelineConfigSchema)(interpolated),
      Effect.mapError(
        (error) =>
          new ConfigValidationError(
            `Schema validation failed: ${String(error)}`,
          ),
      ),
    );

    return config;
  });
};
