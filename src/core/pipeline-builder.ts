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
import { tryParseRedisUrl, type RedisConnection } from "./redis-url.js";

export class BuildError {
  readonly _tag = "BuildError";
  constructor(readonly message: string) {}
}

const configuredComponent = (
  config: object,
): readonly [string, unknown] | undefined =>
  Object.entries(config).find(([, value]) => value !== undefined);

const formatBuildErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = error.message;
    if (typeof message === "string") {
      return message;
    }
  }
  return String(error);
};

const mapCustomBuildError = (name: string, error: unknown): BuildError =>
  new BuildError(
    `Failed to build registered component '${name}': ${formatBuildErrorMessage(error)}`,
  );

const buildRegisteredComponent = <A>(
  name: string,
  build: () => Effect.Effect<A, unknown>,
): Effect.Effect<A, BuildError> =>
  Effect.try({
    try: build,
    catch: (error) => error,
  }).pipe(
    Effect.flatten,
    Effect.mapError((error) => mapCustomBuildError(name, error)),
  );

const parseRedisUrl = (
  url: string,
  label: string,
): Effect.Effect<RedisConnection, BuildError> => {
  const parsed = tryParseRedisUrl(url);
  if (!parsed) {
    return Effect.fail(new BuildError(`Invalid ${label} URL`));
  }
  return Effect.succeed(parsed);
};

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
    const awsSqs = config.aws_sqs;
    return Effect.try({
      try: () =>
        createSqsInput({
          queueUrl: awsSqs.url,
          region: awsSqs.region,
          endpoint: awsSqs.endpoint,
          waitTimeSeconds: awsSqs.wait_time_seconds,
          maxMessages: awsSqs.max_number_of_messages,
          maxAttempts: awsSqs.max_attempts,
          requestTimeout: awsSqs.request_timeout,
          connectionTimeout: awsSqs.connection_timeout,
        }),
      catch: (error) =>
        new BuildError(error instanceof Error ? error.message : String(error)),
    });
  }

  if (config.redis_streams) {
    const streams = config.redis_streams;
    return parseRedisUrl(streams.url, "Redis Streams input").pipe(
      Effect.flatMap(({ host, port, password, db }) =>
        Effect.try({
          try: () =>
            createRedisStreamsInput({
              host,
              port,
              stream: streams.stream,
              password,
              db,
              mode: streams.mode,
              consumerGroup: streams.consumer_group,
              consumerName: streams.consumer_name,
              blockMs: streams.block_ms,
              count: streams.count,
              startId: streams.start_id,
              maxReconnectAttempts: streams.max_reconnect_attempts,
              reconnectBackoffMs: streams.reconnect_backoff_ms,
              connectTimeout: streams.connect_timeout,
              commandTimeout: streams.command_timeout,
              keepAlive: streams.keep_alive,
              lazyConnect: streams.lazy_connect,
              maxRetriesPerRequest: streams.max_retries_per_request,
              enableOfflineQueue: streams.enable_offline_queue,
            }),
          catch: (error) =>
            new BuildError(
              error instanceof Error ? error.message : String(error),
            ),
        }),
      ),
    );
  }

  if (config.redis_pubsub) {
    const redisPubSub = config.redis_pubsub;
    return parseRedisUrl(redisPubSub.url, "Redis Pub/Sub input").pipe(
      Effect.flatMap(({ host, port, password, db }) =>
        Effect.try({
          try: () =>
            createRedisPubSubInput({
              host,
              port,
              channels: redisPubSub.channels
                ? [...redisPubSub.channels]
                : undefined,
              patterns: redisPubSub.patterns
                ? [...redisPubSub.patterns]
                : undefined,
              password: redisPubSub.password ?? password,
              db: redisPubSub.db ?? db,
              queueSize: redisPubSub.queue_size,
              overflow: redisPubSub.overflow,
              connectTimeout: redisPubSub.connect_timeout,
              commandTimeout: redisPubSub.command_timeout,
              keepAlive: redisPubSub.keep_alive,
              lazyConnect: redisPubSub.lazy_connect,
              maxRetriesPerRequest: redisPubSub.max_retries_per_request,
              enableOfflineQueue: redisPubSub.enable_offline_queue,
            }),
          catch: (error) =>
            new BuildError(
              error instanceof Error ? error.message : String(error),
            ),
        }),
      ),
    );
  }

  if (config.redis_list) {
    const redisList = config.redis_list;
    const key =
      typeof redisList.key === "string" ? redisList.key : [...redisList.key];

    return parseRedisUrl(redisList.url, "Redis List input").pipe(
      Effect.flatMap(({ host, port, password, db }) =>
        Effect.try({
          try: () =>
            createRedisListInput({
              host,
              port,
              key,
              direction: redisList.direction,
              timeout: redisList.timeout,
              password: redisList.password ?? password,
              db: redisList.db ?? db,
              connectTimeout: redisList.connect_timeout,
              commandTimeout: redisList.command_timeout,
              keepAlive: redisList.keep_alive,
              lazyConnect: redisList.lazy_connect,
              maxRetriesPerRequest: redisList.max_retries_per_request,
              enableOfflineQueue: redisList.enable_offline_queue,
              maxReconnectAttempts: redisList.max_reconnect_attempts,
              reconnectBackoffMs: redisList.reconnect_backoff_ms,
            }),
          catch: (error) =>
            new BuildError(
              error instanceof Error ? error.message : String(error),
            ),
        }),
      ),
    );
  }

  if (config.http) {
    const http = config.http;
    return Effect.try({
      try: () =>
        createHttpInput({
          port: http.port,
          host: http.host,
          path: http.path,
          timeout: http.timeout,
          queueSize: http.queue_size,
          overflow: http.overflow,
        }),
      catch: (error) =>
        new BuildError(error instanceof Error ? error.message : String(error)),
    });
  }

  if ((config as any).file) {
    return Effect.try({
      try: () =>
        createFileInput({
          path: (config as any).file.path,
          follow: (config as any).file.follow,
          startAt: (config as any).file.start_at,
          pollIntervalMs: (config as any).file.poll_interval_ms,
          encoding: (config as any).file.encoding,
          queueSize: (config as any).file.queue_size,
          overflow: (config as any).file.overflow,
        }),
      catch: (error) =>
        new BuildError(error instanceof Error ? error.message : String(error)),
    });
  }

  if ((config as any).stdin) {
    return Effect.try({
      try: () =>
        createStdinInput({
          mode: (config as any).stdin.mode,
          encoding: (config as any).stdin.encoding,
          queueSize: (config as any).stdin.queue_size,
          overflow: (config as any).stdin.overflow,
        }),
      catch: (error) =>
        new BuildError(error instanceof Error ? error.message : String(error)),
    });
  }

  // Testing utility: generate input
  if ((config as any).generate) {
    return Effect.succeed(createGenerateInput((config as any).generate));
  }

  const selected = configuredComponent(config);
  const registered = selected ? registry?.getInput(selected[0]) : undefined;
  if (selected && registered) {
    return buildRegisteredComponent(selected[0], () =>
      registered.build(selected[1], createBuildContext(registry)),
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
  const assertConfig = config.assert;
  if (assertConfig) {
    return Effect.try({
      try: () => createAssertProcessor(assertConfig),
      catch: (error) =>
        new BuildError(
          `Invalid assert processor configuration: ${error instanceof Error ? error.message : String(error)}`,
        ),
    });
  }

  const selected = configuredComponent(config);
  const registered = selected ? registry?.getProcessor(selected[0]) : undefined;
  if (selected && registered) {
    return buildRegisteredComponent(selected[0], () =>
      registered.build(selected[1], createBuildContext(registry)),
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
    const streams = config.redis_streams;
    return parseRedisUrl(streams.url, "Redis Streams output").pipe(
      Effect.map(({ host, port, password, db }) =>
        createRedisStreamsOutput({
          host,
          port,
          stream: streams.stream,
          maxLen: streams.max_length,
          password,
          db,
          maxRetries: streams.max_retries,
          connectTimeout: streams.connect_timeout,
          commandTimeout: streams.command_timeout,
          keepAlive: streams.keep_alive,
          lazyConnect: streams.lazy_connect,
          maxRetriesPerRequest: streams.max_retries_per_request,
          enableOfflineQueue: streams.enable_offline_queue,
        }),
      ),
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
    const redisPubSub = config.redis_pubsub;
    return parseRedisUrl(redisPubSub.url, "Redis Pub/Sub output").pipe(
      Effect.map(({ host, port, password, db }) =>
        createRedisPubSubOutput({
          host,
          port,
          channel: redisPubSub.channel,
          password: redisPubSub.password ?? password,
          db: redisPubSub.db ?? db,
          maxRetries: redisPubSub.max_retries,
          connectTimeout: redisPubSub.connect_timeout,
          commandTimeout: redisPubSub.command_timeout,
          keepAlive: redisPubSub.keep_alive,
          lazyConnect: redisPubSub.lazy_connect,
          maxRetriesPerRequest: redisPubSub.max_retries_per_request,
          enableOfflineQueue: redisPubSub.enable_offline_queue,
        }),
      ),
    );
  }

  if (config.redis_list) {
    const redisList = config.redis_list;
    return parseRedisUrl(redisList.url, "Redis List output").pipe(
      Effect.map(({ host, port, password, db }) =>
        createRedisListOutput({
          host,
          port,
          key: redisList.key,
          direction: redisList.direction,
          maxLen: redisList.max_length ?? redisList.max_len,
          password: redisList.password ?? password,
          db: redisList.db ?? db,
          maxRetries: redisList.max_retries,
          connectTimeout: redisList.connect_timeout,
          commandTimeout: redisList.command_timeout,
          keepAlive: redisList.keep_alive,
          lazyConnect: redisList.lazy_connect,
          maxRetriesPerRequest: redisList.max_retries_per_request,
          enableOfflineQueue: redisList.enable_offline_queue,
        }),
      ),
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
    return buildRegisteredComponent(selected[0], () =>
      registered.build(selected[1], createBuildContext(registry)),
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

    const processorConfigs = config.pipeline?.processors || [];
    const processors = yield* Effect.forEach(
      processorConfigs,
      (processorConfig) => buildProcessor(processorConfig, registry),
      { concurrency: 1 },
    );

    const input = yield* buildInput(config.input, debug, registry);

    const primaryOutput = yield* buildOutput(config.output, registry);
    let output = primaryOutput;
    let dlqOutput: Output<any> | undefined;

    if (config.dlq) {
      dlqOutput = yield* buildOutput(config.dlq.output, registry);
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
      // Observation handles only when DLQ wrapping hides primary getMessages.
      ...(dlqOutput ? { primaryOutput, dlqOutput } : {}),
      backpressure,
      shutdownTimeoutMs: config.shutdown_timeout_ms,
    };
  });
};
