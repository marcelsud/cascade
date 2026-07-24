/**
 * Pipeline Builder - Constructs pipeline from configuration
 */
import { Effect } from "effect";
import type {
  PipelineConfig,
  InputConfig,
  ProcessorConfig,
  OutputConfig,
} from "./config-loader.js";
import type { Pipeline, Input, Processor, Output } from "./types.js";
import type {
  ComponentBuildContext,
  ComponentRegistry,
} from "./component-registry.js";
import { createDLQRetrySchedule, withDLQ } from "./dlq.js";
import { createSqsInput } from "../inputs/sqs-input.js";
import { createRedisStreamsInput } from "../inputs/redis-streams-input.js";
import { createRedisPubSubInput } from "../inputs/redis-pubsub-input.js";
import { createRedisListInput } from "../inputs/redis-list-input.js";
import { createHttpInput } from "../inputs/http-input.js";
import { createFileInput } from "../inputs/file-input.js";
import { createStdinInput } from "../inputs/stdin-input.js";
import { createMetadataProcessor } from "../processors/metadata-processor.js";
import { createUppercaseProcessor } from "../processors/uppercase-processor.js";
import { createLoggingProcessor } from "../processors/logging-processor.js";
import { createMappingProcessor } from "../processors/mapping-processor.js";
import { createFilterProcessor } from "../processors/filter-processor.js";
import { createHttpProcessor } from "../processors/http-processor.js";
import { createBranchProcessor } from "../processors/branch-processor.js";
import { createSwitchProcessor } from "../processors/switch-processor.js";
import { createDedupeProcessor } from "../processors/dedupe-processor.js";
import { createJavaScriptProcessor } from "../processors/javascript-processor.js";
import { createRedisStreamsOutput } from "../outputs/redis-streams-output.js";
import { createRedisPubSubOutput } from "../outputs/redis-pubsub-output.js";
import { createRedisListOutput } from "../outputs/redis-list-output.js";
import { createSqsOutput } from "../outputs/sqs-output.js";
import { createHttpOutput } from "../outputs/http-output.js";
import { createStdoutOutput } from "../outputs/stdout-output.js";
import { createFileOutput } from "../outputs/file-output.js";
// Testing utilities
import { createGenerateInput } from "../testing/generate-input.js";
import { createCaptureOutput } from "../testing/capture-output.js";
import { createAssertProcessor } from "../testing/assert-processor.js";

export class BuildError {
  readonly _tag = "BuildError";
  constructor(readonly message: string) {}
}

const configuredComponent = (
  config: object,
): readonly [string, unknown] | undefined =>
  Object.entries(config).find(([, value]) => value !== undefined);

const mapCustomBuildError = (name: string, error: unknown): BuildError =>
  new BuildError(
    `Failed to build registered component '${name}': ${error instanceof Error ? error.message : String(error)}`,
  );

/**
 * Build input from configuration (Bento style)
 */
const buildInput = (
  config: InputConfig,
  debug = false,
  registry?: ComponentRegistry,
): Effect.Effect<Input<any>, BuildError> => {
  if (debug) {
    return Effect.gen(function* () {
      yield* Effect.logDebug(
        `buildInput received config: ${JSON.stringify(config, null, 2)}`,
      );
      return yield* buildInputInternal(config, registry);
    });
  }
  return buildInputInternal(config, registry);
};

const buildInputInternal = (
  config: InputConfig,
  registry?: ComponentRegistry,
): Effect.Effect<Input<any>, BuildError> => {
  if (config.aws_sqs) {
    return Effect.succeed(
      createSqsInput({
        queueUrl: config.aws_sqs.url,
        region: config.aws_sqs.region,
        endpoint: config.aws_sqs.endpoint,
        waitTimeSeconds: config.aws_sqs.wait_time_seconds,
        maxMessages: config.aws_sqs.max_number_of_messages,
        maxAttempts: config.aws_sqs.max_attempts,
        requestTimeout: config.aws_sqs.request_timeout,
        connectionTimeout: config.aws_sqs.connection_timeout,
      }),
    );
  }

  if (config.redis_streams) {
    // Parse redis URL (redis://host:port or redis://localhost:6379)
    const url = config.redis_streams.url;
    let host = "localhost";
    let port = 6379;
    let password: string | undefined;
    let db: number | undefined;

    try {
      const urlObj = new URL(url);
      host = urlObj.hostname || "localhost";
      port = urlObj.port ? parseInt(urlObj.port, 10) : 6379;
      password = urlObj.password || undefined;
      // Extract db from pathname if present (redis://host:port/2)
      const pathMatch = urlObj.pathname.match(/^\/(\d+)/);
      if (pathMatch) {
        db = parseInt(pathMatch[1], 10);
      }
    } catch {
      // If URL parsing fails, keep defaults
    }

    return Effect.succeed(
      createRedisStreamsInput({
        host,
        port,
        stream: config.redis_streams.stream,
        password,
        db,
        mode: config.redis_streams.mode,
        consumerGroup: config.redis_streams.consumer_group,
        consumerName: config.redis_streams.consumer_name,
        blockMs: config.redis_streams.block_ms,
        count: config.redis_streams.count,
        startId: config.redis_streams.start_id,
        maxReconnectAttempts: config.redis_streams.max_reconnect_attempts,
        reconnectBackoffMs: config.redis_streams.reconnect_backoff_ms,
      }),
    );
  }

  if (config.redis_pubsub) {
    return Effect.succeed(
      createRedisPubSubInput({
        host: config.redis_pubsub.host || "localhost",
        port: config.redis_pubsub.port || 6379,
        channels: config.redis_pubsub.channels
          ? [...config.redis_pubsub.channels]
          : undefined,
        patterns: config.redis_pubsub.patterns
          ? [...config.redis_pubsub.patterns]
          : undefined,
        password: config.redis_pubsub.password,
        db: config.redis_pubsub.db,
        queueSize: config.redis_pubsub.queue_size,
        overflow: config.redis_pubsub.overflow,
        connectTimeout: config.redis_pubsub.connect_timeout,
        commandTimeout: config.redis_pubsub.command_timeout,
        keepAlive: config.redis_pubsub.keep_alive,
        lazyConnect: config.redis_pubsub.lazy_connect,
        maxRetriesPerRequest: config.redis_pubsub.max_retries_per_request,
        enableOfflineQueue: config.redis_pubsub.enable_offline_queue,
      }),
    );
  }

  if (config.redis_list) {
    const key =
      typeof config.redis_list.key === "string"
        ? config.redis_list.key
        : [...config.redis_list.key];

    return Effect.succeed(
      createRedisListInput({
        host: config.redis_list.host || "localhost",
        port: config.redis_list.port || 6379,
        key,
        direction: config.redis_list.direction,
        timeout: config.redis_list.timeout,
        password: config.redis_list.password,
        db: config.redis_list.db,
        connectTimeout: config.redis_list.connect_timeout,
        commandTimeout: config.redis_list.command_timeout,
        keepAlive: config.redis_list.keep_alive,
        lazyConnect: config.redis_list.lazy_connect,
        maxRetriesPerRequest: config.redis_list.max_retries_per_request,
        enableOfflineQueue: config.redis_list.enable_offline_queue,
        maxReconnectAttempts: config.redis_list.max_reconnect_attempts,
        reconnectBackoffMs: config.redis_list.reconnect_backoff_ms,
      }),
    );
  }

  if (config.http) {
    return Effect.succeed(
      createHttpInput({
        port: config.http.port,
        host: config.http.host,
        path: config.http.path,
        timeout: config.http.timeout,
        queueSize: config.http.queue_size,
        overflow: config.http.overflow,
      }),
    );
  }

  if ((config as any).file) {
    return Effect.succeed(
      createFileInput({
        path: (config as any).file.path,
        follow: (config as any).file.follow,
        startAt: (config as any).file.start_at,
        pollIntervalMs: (config as any).file.poll_interval_ms,
        encoding: (config as any).file.encoding,
        queueSize: (config as any).file.queue_size,
        overflow: (config as any).file.overflow,
      }),
    );
  }

  if ((config as any).stdin) {
    return Effect.succeed(
      createStdinInput({
        mode: (config as any).stdin.mode,
        encoding: (config as any).stdin.encoding,
        queueSize: (config as any).stdin.queue_size,
        overflow: (config as any).stdin.overflow,
      }),
    );
  }

  // Testing utility: generate input
  if ((config as any).generate) {
    return Effect.succeed(createGenerateInput((config as any).generate));
  }

  const selected = configuredComponent(config);
  const registered = selected ? registry?.getInput(selected[0]) : undefined;
  if (selected && registered) {
    return registered
      .build(selected[1], createBuildContext(registry))
      .pipe(
        Effect.mapError((error) => mapCustomBuildError(selected[0], error)),
      );
  }

  if (selected) {
    return Effect.fail(
      new BuildError(
        `Unknown input component '${selected[0]}' — is the registry passed to buildPipeline?`,
      ),
    );
  }

  return Effect.fail(new BuildError("No valid input configuration found"));
};

/**
 * Build processor from configuration (Bento style)
 */
const buildProcessor = (
  config: ProcessorConfig,
  registry?: ComponentRegistry,
): Effect.Effect<Processor<any>, BuildError> => {
  if (config.metadata) {
    return Effect.succeed(
      createMetadataProcessor({
        correlationIdField: config.metadata.correlation_id_field,
        addTimestamp: config.metadata.add_timestamp,
      }),
    );
  }

  if (config.uppercase) {
    if (!config.uppercase.fields) {
      return Effect.fail(
        new BuildError("Uppercase processor requires 'fields' configuration"),
      );
    }
    return Effect.succeed(
      createUppercaseProcessor({
        fields: config.uppercase.fields,
      }),
    );
  }

  if (config.log) {
    return Effect.succeed(
      createLoggingProcessor({
        level: config.log.level,
        includeContent: config.log.include_content,
      }),
    );
  }

  if (config.mapping) {
    return Effect.succeed(
      createMappingProcessor({
        expression: config.mapping.expression,
      }),
    );
  }

  if (config.filter) {
    return Effect.try({
      try: () => createFilterProcessor({ check: config.filter!.check }),
      catch: (error) =>
        new BuildError(
          error instanceof Error
            ? error.message
            : `Failed to build filter processor: ${String(error)}`,
        ),
    });
  }

  if (config.http) {
    return Effect.succeed(
      createHttpProcessor({
        url: config.http.url,
        method: config.http.method,
        body: config.http.body,
        headers: config.http.headers,
        timeout: config.http.timeout,
        maxRetries: config.http.max_retries,
        auth: config.http.auth,
        resultKey: config.http.result_key,
        resultMapping: config.http.result_mapping,
      }),
    );
  }

  if (config.branch) {
    const branchConfig = config.branch;
    return Effect.gen(function* () {
      // Recursively build nested processors
      const nestedProcessors: Processor<any, any>[] = yield* Effect.forEach(
        [...branchConfig.processors],
        (nestedConfig) => buildProcessor(nestedConfig, registry),
        { concurrency: 1 },
      );
      return createBranchProcessor({ processors: nestedProcessors });
    }) as Effect.Effect<Processor<any>, BuildError>;
  }

  if (config.switch) {
    const switchConfig = config.switch;
    return Effect.gen(function* () {
      // Recursively build processors for each case
      const cases = yield* Effect.forEach(
        [...switchConfig.cases],
        (switchCase) =>
          Effect.gen(function* () {
            const processors: Processor<any, any>[] = yield* Effect.forEach(
              [...switchCase.processors],
              (nestedConfig) => buildProcessor(nestedConfig, registry),
              { concurrency: 1 },
            );
            return {
              check: switchCase.check,
              processors,
            };
          }),
        { concurrency: 1 },
      );
      return createSwitchProcessor({ cases });
    }) as Effect.Effect<Processor<any>, BuildError>;
  }

  if (config.dedupe) {
    if (!config.dedupe.key) {
      return Effect.fail(
        new BuildError(
          "Dedupe processor requires a non-empty 'key' field specifying the deduplication attribute (e.g. 'messageId' or 'metadata.correlationId')",
        ),
      );
    }
    return Effect.succeed(
      createDedupeProcessor({
        key: config.dedupe.key,
        windowMs: config.dedupe.window_ms,
        maxKeys: config.dedupe.max_keys,
      }),
    );
  }

  if (config.javascript) {
    return Effect.succeed(
      createJavaScriptProcessor({
        code: config.javascript.code,
        timeout_ms: config.javascript.timeout_ms,
        memory_limit_bytes: config.javascript.memory_limit_bytes,
      }),
    );
  }

  // Testing utility: assert processor
  if ((config as any).assert) {
    return Effect.succeed(createAssertProcessor((config as any).assert));
  }

  const selected = configuredComponent(config);
  const registered = selected ? registry?.getProcessor(selected[0]) : undefined;
  if (selected && registered) {
    return registered
      .build(selected[1], createBuildContext(registry))
      .pipe(
        Effect.mapError((error) => mapCustomBuildError(selected[0], error)),
      );
  }

  if (selected) {
    return Effect.fail(
      new BuildError(
        `Unknown processor component '${selected[0]}' — is the registry passed to buildPipeline?`,
      ),
    );
  }

  return Effect.fail(new BuildError("No valid processor configuration found"));
};

const createBuildContext = (
  registry?: ComponentRegistry,
): ComponentBuildContext => ({
  buildProcessor: (config) => buildProcessor(config, registry),
});

/**
 * Build output from configuration (Bento style)
 */
const buildOutput = (
  config: OutputConfig,
  registry?: ComponentRegistry,
): Effect.Effect<Output<any>, BuildError> => {
  if (config.redis_streams) {
    // Parse redis URL (redis://host:port or redis://localhost:6379)
    const url = config.redis_streams.url;
    let host = "localhost";
    let port = 6379;
    let password: string | undefined;
    let db: number | undefined;

    try {
      const urlObj = new URL(url);
      host = urlObj.hostname || "localhost";
      port = urlObj.port ? parseInt(urlObj.port, 10) : 6379;
      password = urlObj.password || undefined;
      // Extract db from pathname if present (redis://host:port/2)
      const pathMatch = urlObj.pathname.match(/^\/(\d+)/);
      if (pathMatch) {
        db = parseInt(pathMatch[1], 10);
      }
    } catch {
      // If URL parsing fails, keep defaults
    }

    return Effect.succeed(
      createRedisStreamsOutput({
        host,
        port,
        stream: config.redis_streams.stream,
        maxLen: config.redis_streams.max_length,
        password,
        db,
        maxRetries: config.redis_streams.max_retries,
        connectTimeout: config.redis_streams.connect_timeout,
        commandTimeout: config.redis_streams.command_timeout,
        keepAlive: config.redis_streams.keep_alive,
        lazyConnect: config.redis_streams.lazy_connect,
        maxRetriesPerRequest: config.redis_streams.max_retries_per_request,
        enableOfflineQueue: config.redis_streams.enable_offline_queue,
      }),
    );
  }

  if (config.aws_sqs) {
    return Effect.succeed(
      createSqsOutput({
        queueUrl: config.aws_sqs.url,
        region: config.aws_sqs.region,
        endpoint: config.aws_sqs.endpoint,
        maxBatchSize: config.aws_sqs.max_batch_size,
        delaySeconds: config.aws_sqs.delay_seconds,
        batchTimeout: config.aws_sqs.batch_timeout,
        maxRetries: config.aws_sqs.max_retries,
        maxAttempts: config.aws_sqs.max_attempts,
        requestTimeout: config.aws_sqs.request_timeout,
        connectionTimeout: config.aws_sqs.connection_timeout,
      }),
    );
  }

  if (config.redis_pubsub) {
    return Effect.succeed(
      createRedisPubSubOutput({
        host: config.redis_pubsub.host || "localhost",
        port: config.redis_pubsub.port || 6379,
        channel: config.redis_pubsub.channel,
        password: config.redis_pubsub.password,
        db: config.redis_pubsub.db,
        maxRetries: config.redis_pubsub.max_retries,
        connectTimeout: config.redis_pubsub.connect_timeout,
        commandTimeout: config.redis_pubsub.command_timeout,
        keepAlive: config.redis_pubsub.keep_alive,
        lazyConnect: config.redis_pubsub.lazy_connect,
        maxRetriesPerRequest: config.redis_pubsub.max_retries_per_request,
        enableOfflineQueue: config.redis_pubsub.enable_offline_queue,
      }),
    );
  }

  if (config.redis_list) {
    return Effect.succeed(
      createRedisListOutput({
        host: config.redis_list.host || "localhost",
        port: config.redis_list.port || 6379,
        key: config.redis_list.key,
        direction: config.redis_list.direction,
        maxLen: config.redis_list.max_length ?? config.redis_list.max_len,
        password: config.redis_list.password,
        db: config.redis_list.db,
        maxRetries: config.redis_list.max_retries,
        connectTimeout: config.redis_list.connect_timeout,
        commandTimeout: config.redis_list.command_timeout,
        keepAlive: config.redis_list.keep_alive,
        lazyConnect: config.redis_list.lazy_connect,
        maxRetriesPerRequest: config.redis_list.max_retries_per_request,
        enableOfflineQueue: config.redis_list.enable_offline_queue,
      }),
    );
  }

  if (config.http) {
    return Effect.succeed(
      createHttpOutput({
        url: config.http.url,
        method: config.http.method,
        headers: config.http.headers,
        timeout: config.http.timeout,
        maxRetries: config.http.max_retries,
        auth: config.http.auth,
      }),
    );
  }

  if (config.stdout) {
    return Effect.succeed(
      createStdoutOutput({
        format: config.stdout.format,
      }),
    );
  }

  if (config.file) {
    return Effect.try({
      try: () =>
        createFileOutput({
          path: config.file!.path,
          format: config.file!.format,
          mode: config.file!.mode,
        }),
      catch: (error) =>
        new BuildError(
          error instanceof Error
            ? error.message
            : `Failed to build file output: ${String(error)}`,
        ),
    });
  }

  // Testing utility: capture output
  if ((config as any).capture) {
    return createCaptureOutput((config as any).capture || {});
  }

  const selected = configuredComponent(config);
  const registered = selected ? registry?.getOutput(selected[0]) : undefined;
  if (selected && registered) {
    return registered
      .build(selected[1], createBuildContext(registry))
      .pipe(
        Effect.mapError((error) => mapCustomBuildError(selected[0], error)),
      );
  }

  if (selected) {
    return Effect.fail(
      new BuildError(
        `Unknown output component '${selected[0]}' — is the registry passed to buildPipeline?`,
      ),
    );
  }

  return Effect.fail(new BuildError("No valid output configuration found"));
};

/**
 * Build complete pipeline from configuration (Bento style)
 */
export const buildPipeline = (
  config: PipelineConfig,
  debug = false,
  registry?: ComponentRegistry,
): Effect.Effect<Pipeline<any>, BuildError> => {
  return Effect.gen(function* () {
    if (debug) {
      yield* Effect.logDebug(
        `buildPipeline received config: ${JSON.stringify(config, null, 2)}`,
      );
    }

    const input = yield* buildInput(config.input, debug, registry);

    const processorConfigs = config.pipeline?.processors || [];
    const processors = yield* Effect.forEach(
      processorConfigs,
      (processorConfig) => buildProcessor(processorConfig, registry),
      { concurrency: 1 },
    );

    const primaryOutput = yield* buildOutput(config.output, registry);
    let output = primaryOutput;

    if (config.dlq) {
      const dlqOutput = yield* buildOutput(config.dlq.output, registry);
      output = withDLQ({
        output: primaryOutput,
        dlq: dlqOutput,
        maxRetries: config.dlq.max_retries,
        retrySchedule: createDLQRetrySchedule(
          config.dlq.retry_schedule,
          config.dlq.retry_interval_ms,
        ),
      });
    }

    const inputType = configuredComponent(config.input)?.[0] ?? "unknown";
    const outputType = configuredComponent(config.output)?.[0] ?? "unknown";

    const maxConcurrentMessages =
      config.pipeline?.backpressure?.max_concurrent_messages;
    const maxConcurrentOutputs =
      config.pipeline?.backpressure?.max_concurrent_outputs;
    const backpressure =
      maxConcurrentMessages !== undefined || maxConcurrentOutputs !== undefined
        ? { maxConcurrentMessages, maxConcurrentOutputs }
        : undefined;

    return {
      name: `${inputType}-to-${outputType}`,
      input,
      processors,
      output,
      backpressure,
      shutdownTimeoutMs: config.shutdown_timeout_ms,
    };
  });
};
