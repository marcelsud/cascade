/**
 * Pipeline configuration schemas
 */
import * as S from "effect/Schema";
import type { ComponentKind, ComponentRegistry } from "./component-registry.js";

const validateExactlyOneComponent = (
  label: string,
  config: object,
): true | string => {
  const configuredComponents = Object.entries(config)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key)
    .sort();

  if (configuredComponents.length === 1) return true;

  const found = configuredComponents.join(", ") || "none";
  const unknownComponentHint =
    configuredComponents.length === 0
      ? " — check for unknown or misspelled component names"
      : "";

  return `${label} must configure exactly one component; found: ${found}${unknownComponentHint}`;
};

const customSchemaFields = (
  registry: ComponentRegistry | undefined,
  kind: ComponentKind,
  reservedNames: ReadonlySet<string>,
): Record<string, S.optional<S.Schema.Any>> => {
  if (!registry) return {};
  registry.assertNoConflicts(kind, reservedNames);
  return Object.fromEntries(
    Object.entries(registry.getSchemas(kind)).map(([name, schema]) => [
      name,
      S.optional(schema),
    ]),
  );
};

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
  max_reconnect_attempts: S.optional(S.Int.pipe(S.nonNegative())),
  reconnect_backoff_ms: S.optional(S.Int.pipe(S.positive())),
});

/**
 * Schema for HTTP Input configuration (Bento style)
 */
const HttpInputSchema = S.Struct({
  port: S.Number,
  host: S.optional(S.String),
  path: S.optional(S.String),
  timeout: S.optional(S.Number),
  queue_size: S.optional(S.Int.pipe(S.positive())),
  overflow: S.optional(S.Literal("block", "drop_new", "drop_old")),
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
  queue_size: S.optional(S.Int.pipe(S.positive())),
  overflow: S.optional(S.Literal("block", "drop_new", "drop_old")),
});

/**
 * Schema for Stdin Input configuration
 */
const StdinInputSchema = S.Struct({
  mode: S.optional(S.Union(S.Literal("lines"), S.Literal("whole"))),
  encoding: S.optional(S.String),
  queue_size: S.optional(S.Int.pipe(S.positive())),
  overflow: S.optional(S.Literal("block", "drop_new", "drop_old")),
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
  queue_size: S.optional(S.Int.pipe(S.positive())),
  overflow: S.optional(S.Literal("block", "drop_new", "drop_old")),
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
  max_reconnect_attempts: S.optional(S.Int.pipe(S.nonNegative())),
  reconnect_backoff_ms: S.optional(S.Int.pipe(S.positive())),
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
const InputConfigFields = {
  aws_sqs: S.optional(AwsSqsInputSchema),
  redis_streams: S.optional(RedisStreamsInputSchema),
  redis_pubsub: S.optional(RedisPubSubInputSchema),
  redis_list: S.optional(RedisListInputSchema),
  http: S.optional(HttpInputSchema),
  file: S.optional(FileInputSchema),
  stdin: S.optional(StdinInputSchema),
  generate: S.optional(GenerateInputSchema),
};

const createInputConfigSchema = (registry?: ComponentRegistry) =>
  S.Struct({
    ...InputConfigFields,
    ...customSchemaFields(
      registry,
      "input",
      new Set(Object.keys(InputConfigFields)),
    ),
  }).pipe(S.filter((config) => validateExactlyOneComponent("Input", config)));

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
        message: () => "Dedupe processor 'max_keys' must be a positive integer",
      }),
    ),
  ),
});

/**
 * Schema for JavaScript Processor (sandboxed QuickJS execution)
 */
const JavaScriptProcessorSchema = S.Struct({
  code: S.String,
  timeout_ms: S.optional(S.Number),
  memory_limit_bytes: S.optional(S.Number),
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
const createProcessorConfigSchema = (registry?: ComponentRegistry) => {
  let processorSchema: S.Schema<ProcessorConfig>;
  processorSchema = S.suspend(() =>
    S.Struct({
      metadata: S.optional(MetadataProcessorSchema),
      uppercase: S.optional(UppercaseProcessorSchema),
      log: S.optional(LogProcessorSchema),
      mapping: S.optional(MappingProcessorSchema),
      http: S.optional(HttpProcessorSchema),
      branch: S.optional(
        S.Struct({
          processors: S.Array(S.suspend(() => processorSchema)),
        }),
      ),
      switch: S.optional(
        S.Struct({
          cases: S.Array(
            S.Struct({
              check: S.String,
              processors: S.Array(S.suspend(() => processorSchema)),
            }),
          ),
        }),
      ),
      dedupe: S.optional(DedupeProcessorSchema),
      javascript: S.optional(JavaScriptProcessorSchema),
      // Testing utilities
      assert: S.optional(AssertProcessorSchema),
      ...customSchemaFields(
        registry,
        "processor",
        new Set([
          "metadata",
          "uppercase",
          "log",
          "mapping",
          "http",
          "branch",
          "switch",
          "dedupe",
          "javascript",
          "assert",
        ]),
      ),
    }).pipe(
      S.filter((config) => validateExactlyOneComponent("Processor", config)),
    ),
  ) as S.Schema<ProcessorConfig>;
  return processorSchema;
};

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
 * Schema for Stdout Output configuration
 *
 * @experimental Alpha component — shape may change before it stabilizes.
 */
const StdoutOutputSchema = S.Struct({
  format: S.optional(S.Union(S.Literal("content"), S.Literal("message"))),
});

/**
 * Output configuration - detects type by key
 */
const OutputConfigFields = {
  redis_streams: S.optional(RedisStreamsOutputSchema),
  redis_pubsub: S.optional(RedisPubSubOutputSchema),
  redis_list: S.optional(RedisListOutputSchema),
  aws_sqs: S.optional(AwsSqsOutputSchema),
  http: S.optional(HttpOutputSchema),
  stdout: S.optional(StdoutOutputSchema),
  capture: S.optional(CaptureOutputSchema),
};

const createOutputConfigSchema = (registry?: ComponentRegistry) =>
  S.Struct({
    ...OutputConfigFields,
    ...customSchemaFields(
      registry,
      "output",
      new Set(Object.keys(OutputConfigFields)),
    ),
  }).pipe(S.filter((config) => validateExactlyOneComponent("Output", config)));

/**
 * Complete pipeline configuration schema (Bento style)
 */
export const createPipelineConfigSchema = (registry?: ComponentRegistry) => {
  const input = createInputConfigSchema(registry);
  const processor = createProcessorConfigSchema(registry);
  const output = createOutputConfigSchema(registry);

  return S.Struct({
    input,
    shutdown_timeout_ms: S.optional(S.Int.pipe(S.positive())),
    pipeline: S.optional(
      S.Struct({
        processors: S.optional(S.Array(processor)),
        backpressure: S.optional(
          S.Struct({
            max_concurrent_messages: S.optional(S.Int.pipe(S.positive())),
            max_concurrent_outputs: S.optional(S.Int.pipe(S.positive())),
          }),
        ),
      }),
    ),
    output,
    dlq: S.optional(
      S.Struct({
        output,
        max_retries: S.optional(S.Int.pipe(S.nonNegative())),
        retry_schedule: S.optional(S.Literal("exponential", "fixed", "linear")),
        retry_interval_ms: S.optional(S.Int.pipe(S.positive())),
      }),
    ),
  });
};

/**
 * Strict validation for the stable configuration envelope. Component payloads
 * and processor entries stay opaque so registered components can own them.
 */
export const PipelineConfigEnvelopeSchema = S.Struct({
  input: S.Unknown,
  shutdown_timeout_ms: S.optional(S.Unknown),
  pipeline: S.optional(
    S.Struct({
      processors: S.optional(S.Unknown),
      backpressure: S.optional(
        S.Struct({
          max_concurrent_messages: S.optional(S.Unknown),
          max_concurrent_outputs: S.optional(S.Unknown),
        }),
      ),
    }),
  ),
  output: S.Unknown,
  dlq: S.optional(
    S.Struct({
      output: S.Unknown,
      max_retries: S.optional(S.Unknown),
      retry_schedule: S.optional(S.Unknown),
      retry_interval_ms: S.optional(S.Unknown),
    }),
  ),
});

export const PipelineConfigSchema = createPipelineConfigSchema();

/**
 * TypeScript type inferred from schema
 */
export type PipelineConfig = S.Schema.Type<typeof PipelineConfigSchema>;
export type InputConfig = S.Schema.Type<
  ReturnType<typeof createInputConfigSchema>
>;
export type OutputConfig = S.Schema.Type<
  ReturnType<typeof createOutputConfigSchema>
>;

/**
 * ProcessorConfig type - manually defined as recursive
 */
export type ProcessorConfig = {
  readonly [key: string]: unknown;
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
  readonly javascript?: {
    readonly code: string;
    readonly timeout_ms?: number;
    readonly memory_limit_bytes?: number;
  };
  // Testing utilities
  readonly assert?: {
    readonly expression: string;
    readonly expected: unknown;
  };
};
