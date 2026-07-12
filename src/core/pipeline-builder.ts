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
// Testing utilities
import { createGenerateInput } from "../testing/generate-input.js";
import { createCaptureOutput } from "../testing/capture-output.js";
import { createAssertProcessor } from "../testing/assert-processor.js";

export class BuildError {
  readonly _tag = "BuildError";
  constructor(readonly message: string) {}
}

/**
 * Build input from configuration (Bento style)
 */
const buildInput = (
  config: InputConfig,
  debug = false,
): Effect.Effect<Input<any>, BuildError> => {
  if (debug) {
    return Effect.gen(function* () {
      yield* Effect.logDebug(
        `buildInput received config: ${JSON.stringify(config, null, 2)}`,
      );
      return yield* buildInputInternal(config);
    });
  }
  return buildInputInternal(config);
};

const buildInputInternal = (
  config: InputConfig,
): Effect.Effect<Input<any>, BuildError> => {
  if (config.aws_sqs) {
    return Effect.succeed(
      createSqsInput({
        queueUrl: config.aws_sqs.url,
        region: config.aws_sqs.region,
        endpoint: config.aws_sqs.endpoint,
        waitTimeSeconds: config.aws_sqs.wait_time_seconds,
        maxMessages: config.aws_sqs.max_number_of_messages,
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
      }),
    );
  }

  if ((config as any).stdin) {
    return Effect.succeed(
      createStdinInput({
        mode: (config as any).stdin.mode,
        encoding: (config as any).stdin.encoding,
      }),
    );
  }

  // Testing utility: generate input
  if ((config as any).generate) {
    return Effect.succeed(createGenerateInput((config as any).generate));
  }

  return Effect.fail(new BuildError("No valid input configuration found"));
};

/**
 * Build processor from configuration (Bento style)
 */
const buildProcessor = (
  config: ProcessorConfig,
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
        buildProcessor,
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
              buildProcessor,
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

  return Effect.fail(new BuildError("No valid processor configuration found"));
};

/**
 * Build output from configuration (Bento style)
 */
const buildOutput = (
  config: OutputConfig,
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
        maxLen: config.redis_list.max_length,
        password: config.redis_list.password,
        db: config.redis_list.db,
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

  // Testing utility: capture output
  if ((config as any).capture) {
    return createCaptureOutput((config as any).capture || {});
  }

  return Effect.fail(new BuildError("No valid output configuration found"));
};

/**
 * Build complete pipeline from configuration (Bento style)
 */
export const buildPipeline = (
  config: PipelineConfig,
  debug = false,
): Effect.Effect<Pipeline<any>, BuildError> => {
  return Effect.gen(function* () {
    if (debug) {
      yield* Effect.logDebug(
        `buildPipeline received config: ${JSON.stringify(config, null, 2)}`,
      );
    }

    const input = yield* buildInput(config.input, debug);

    const processorConfigs = config.pipeline?.processors || [];
    const processors = yield* Effect.forEach(processorConfigs, buildProcessor, {
      concurrency: 1,
    });

    const output = yield* buildOutput(config.output);

    // Generate name from input and output types
    const inputType = config.input.aws_sqs
      ? "aws_sqs"
      : config.input.redis_streams
        ? "redis_streams"
        : config.input.http
          ? "http"
          : (config.input as any).file
            ? "file"
            : (config.input as any).stdin
              ? "stdin"
          : (config.input as any).generate
            ? "generate"
            : "unknown";
    const outputType = config.output.redis_streams
      ? "redis_streams"
      : config.output.aws_sqs
        ? "aws_sqs"
        : config.output.http
          ? "http"
          : (config.output as any).capture
            ? "capture"
            : "unknown";

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
    };
  });
};
