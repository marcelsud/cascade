import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Effect, Either, Stream } from "effect";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as yaml from "yaml";
import { loadConfig } from "../../../src/core/config-loader.js";
import {
  BuildError,
  buildPipeline,
} from "../../../src/core/pipeline-builder.js";
import type { Input, Output } from "../../../src/core/types.js";

const { createSqsInputMock } = vi.hoisted(() => ({
  createSqsInputMock: vi.fn(),
}));
const { createSqsOutputMock } = vi.hoisted(() => ({
  createSqsOutputMock: vi.fn(),
}));
const { createRedisListInputMock } = vi.hoisted(() => ({
  createRedisListInputMock: vi.fn(),
}));
const { createRedisPubSubInputMock } = vi.hoisted(() => ({
  createRedisPubSubInputMock: vi.fn(),
}));
const { createRedisStreamsInputMock } = vi.hoisted(() => ({
  createRedisStreamsInputMock: vi.fn(),
}));
const { createRedisListOutputMock } = vi.hoisted(() => ({
  createRedisListOutputMock: vi.fn(),
}));
const { createRedisPubSubOutputMock } = vi.hoisted(() => ({
  createRedisPubSubOutputMock: vi.fn(),
}));
const { createRedisStreamsOutputMock } = vi.hoisted(() => ({
  createRedisStreamsOutputMock: vi.fn(),
}));

vi.mock("../../../src/inputs/sqs-input.js", () => ({
  createSqsInput: createSqsInputMock,
}));
vi.mock("../../../src/inputs/redis-list-input.js", () => ({
  createRedisListInput: createRedisListInputMock,
}));
vi.mock("../../../src/inputs/redis-pubsub-input.js", () => ({
  createRedisPubSubInput: createRedisPubSubInputMock,
}));
vi.mock("../../../src/inputs/redis-streams-input.js", () => ({
  createRedisStreamsInput: createRedisStreamsInputMock,
}));
vi.mock("../../../src/outputs/sqs-output.js", () => ({
  createSqsOutput: createSqsOutputMock,
}));
vi.mock("../../../src/outputs/redis-list-output.js", () => ({
  createRedisListOutput: createRedisListOutputMock,
}));
vi.mock("../../../src/outputs/redis-pubsub-output.js", () => ({
  createRedisPubSubOutput: createRedisPubSubOutputMock,
}));
vi.mock("../../../src/outputs/redis-streams-output.js", () => ({
  createRedisStreamsOutput: createRedisStreamsOutputMock,
}));

const stubInput = (name: string): Input => ({
  name,
  stream: Stream.empty,
});

const stubOutput = (name: string): Output => ({
  name,
  send: () => Effect.void,
});

const tempDirs: string[] = [];

const writeTempYaml = async (config: unknown): Promise<string> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cascade-reliability-"));
  tempDirs.push(dir);
  const configPath = path.join(dir, "config.yaml");
  await fs.writeFile(configPath, yaml.stringify(config), "utf8");
  return configPath;
};

const loadAndBuild = async (configPath: string) => {
  const config = await Effect.runPromise(loadConfig(configPath));
  return Effect.runPromise(buildPipeline(config));
};

beforeEach(() => {
  createSqsInputMock.mockReset();
  createSqsOutputMock.mockReset();
  createRedisListInputMock.mockReset();
  createRedisPubSubInputMock.mockReset();
  createRedisStreamsInputMock.mockReset();
  createRedisListOutputMock.mockReset();
  createRedisPubSubOutputMock.mockReset();
  createRedisStreamsOutputMock.mockReset();

  createSqsInputMock.mockImplementation(() => stubInput("sqs-input"));
  createSqsOutputMock.mockImplementation(() => stubOutput("sqs-output"));
  createRedisListInputMock.mockImplementation(() =>
    stubInput("redis-list-input"),
  );
  createRedisPubSubInputMock.mockImplementation(() =>
    stubInput("redis-pubsub-input"),
  );
  createRedisStreamsInputMock.mockImplementation(() =>
    stubInput("redis-streams-input"),
  );
  createRedisListOutputMock.mockImplementation(() =>
    stubOutput("redis-list-output"),
  );
  createRedisPubSubOutputMock.mockImplementation(() =>
    stubOutput("redis-pubsub-output"),
  );
  createRedisStreamsOutputMock.mockImplementation(() =>
    stubOutput("redis-streams-output"),
  );
});

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true })),
  );
});

describe("reliability settings reach connector factories", () => {
  it("forwards SQS input reliability YAML to createSqsInput", async () => {
    const configPath = await writeTempYaml({
      input: {
        aws_sqs: {
          url: "http://localhost:4566/000000000000/input-queue",
          region: "us-east-1",
          endpoint: "http://localhost:4566",
          wait_time_seconds: 5,
          max_number_of_messages: 7,
          max_attempts: 9,
          request_timeout: 12345,
          connection_timeout: 999,
        },
      },
      output: {
        capture: {},
      },
    });

    await loadAndBuild(configPath);

    expect(createSqsInputMock).toHaveBeenCalledTimes(1);
    expect(createSqsInputMock).toHaveBeenCalledWith({
      queueUrl: "http://localhost:4566/000000000000/input-queue",
      region: "us-east-1",
      endpoint: "http://localhost:4566",
      waitTimeSeconds: 5,
      maxMessages: 7,
      maxAttempts: 9,
      requestTimeout: 12345,
      connectionTimeout: 999,
    });
  });

  it("forwards Redis list input connection YAML to createRedisListInput", async () => {
    const configPath = await writeTempYaml({
      input: {
        redis_list: {
          host: "list-in.example",
          port: 6382,
          key: ["high", "low"],
          direction: "right",
          timeout: 12,
          password: "list-secret",
          db: 5,
          connect_timeout: 2100,
          command_timeout: 3100,
          keep_alive: 41000,
          lazy_connect: true,
          max_retries_per_request: 14,
          enable_offline_queue: false,
          max_reconnect_attempts: 6,
          reconnect_backoff_ms: 750,
        },
      },
      output: {
        capture: {},
      },
    });

    await loadAndBuild(configPath);

    expect(createRedisListInputMock).toHaveBeenCalledTimes(1);
    expect(createRedisListInputMock).toHaveBeenCalledWith({
      host: "list-in.example",
      port: 6382,
      key: ["high", "low"],
      direction: "right",
      timeout: 12,
      password: "list-secret",
      db: 5,
      connectTimeout: 2100,
      commandTimeout: 3100,
      keepAlive: 41000,
      lazyConnect: true,
      maxRetriesPerRequest: 14,
      enableOfflineQueue: false,
      maxReconnectAttempts: 6,
      reconnectBackoffMs: 750,
    });
  });

  it("forwards Redis pubsub input connection YAML to createRedisPubSubInput", async () => {
    const configPath = await writeTempYaml({
      input: {
        redis_pubsub: {
          host: "pubsub-in.example",
          port: 6383,
          channels: ["events", "alerts"],
          patterns: ["logs:*"],
          password: "pubsub-secret",
          db: 6,
          queue_size: 250,
          overflow: "drop_old",
          connect_timeout: 1800,
          command_timeout: 2800,
          keep_alive: 36000,
          lazy_connect: true,
          max_retries_per_request: 9,
          enable_offline_queue: false,
        },
      },
      output: {
        capture: {},
      },
    });

    await loadAndBuild(configPath);

    expect(createRedisPubSubInputMock).toHaveBeenCalledTimes(1);
    expect(createRedisPubSubInputMock).toHaveBeenCalledWith({
      host: "pubsub-in.example",
      port: 6383,
      channels: ["events", "alerts"],
      patterns: ["logs:*"],
      password: "pubsub-secret",
      db: 6,
      queueSize: 250,
      overflow: "drop_old",
      connectTimeout: 1800,
      commandTimeout: 2800,
      keepAlive: 36000,
      lazyConnect: true,
      maxRetriesPerRequest: 9,
      enableOfflineQueue: false,
    });
  });

  it("forwards Redis streams input reliability YAML to createRedisStreamsInput", async () => {
    const configPath = await writeTempYaml({
      input: {
        redis_streams: {
          url: "redis://:stream-in-secret@streams-in.example:6391/7",
          stream: "inbound-events",
          mode: "consumer-group",
          consumer_group: "cascade-workers",
          consumer_name: "worker-1",
          block_ms: 2500,
          count: 42,
          start_id: "0-0",
          max_reconnect_attempts: 4,
          reconnect_backoff_ms: 800,
          connect_timeout: 1900,
          command_timeout: 2900,
          keep_alive: 37000,
          lazy_connect: true,
          max_retries_per_request: 13,
          enable_offline_queue: false,
        },
      },
      output: {
        capture: {},
      },
    });

    await loadAndBuild(configPath);

    expect(createRedisStreamsInputMock).toHaveBeenCalledTimes(1);
    expect(createRedisStreamsInputMock).toHaveBeenCalledWith({
      host: "streams-in.example",
      port: 6391,
      stream: "inbound-events",
      password: "stream-in-secret",
      db: 7,
      mode: "consumer-group",
      consumerGroup: "cascade-workers",
      consumerName: "worker-1",
      blockMs: 2500,
      count: 42,
      startId: "0-0",
      maxReconnectAttempts: 4,
      reconnectBackoffMs: 800,
      connectTimeout: 1900,
      commandTimeout: 2900,
      keepAlive: 37000,
      lazyConnect: true,
      maxRetriesPerRequest: 13,
      enableOfflineQueue: false,
    });
  });

  it.each(["%%%not-a-url%%%", "http://streams.example:6379/2"])(
    "rejects malformed Redis streams input URL %s without calling factory",
    async (url) => {
      const configPath = await writeTempYaml({
        input: {
          redis_streams: {
            url,
            stream: "inbound-events",
          },
        },
        output: {
          capture: {},
        },
      });

      const config = await Effect.runPromise(loadConfig(configPath));
      const result = await Effect.runPromise(
        Effect.either(buildPipeline(config)),
      );

      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left).toBeInstanceOf(BuildError);
        expect(result.left._tag).toBe("BuildError");
        expect(result.left.message).toBe("Invalid Redis Streams input URL");
      }
      expect(createRedisStreamsInputMock).not.toHaveBeenCalled();
    },
  );

  it("forwards SQS output reliability YAML to createSqsOutput", async () => {
    const configPath = await writeTempYaml({
      input: {
        generate: {
          count: 1,
          template: { ok: true },
        },
      },
      output: {
        aws_sqs: {
          url: "http://localhost:4566/000000000000/output-queue",
          region: "us-west-2",
          endpoint: "http://localhost:4566",
          max_batch_size: 8,
          delay_seconds: 4,
          batch_timeout: 5000,
          max_retries: 7,
          max_attempts: 6,
          request_timeout: 11111,
          connection_timeout: 2222,
        },
      },
    });

    await loadAndBuild(configPath);

    expect(createSqsOutputMock).toHaveBeenCalledTimes(1);
    expect(createSqsOutputMock).toHaveBeenCalledWith({
      queueUrl: "http://localhost:4566/000000000000/output-queue",
      region: "us-west-2",
      endpoint: "http://localhost:4566",
      maxBatchSize: 8,
      delaySeconds: 4,
      batchTimeout: 5000,
      maxRetries: 7,
      maxAttempts: 6,
      requestTimeout: 11111,
      connectionTimeout: 2222,
    });
  });

  it("forwards Redis list output reliability YAML to createRedisListOutput", async () => {
    const configPath = await writeTempYaml({
      input: {
        generate: {
          count: 1,
          template: { ok: true },
        },
      },
      output: {
        redis_list: {
          host: "redis.example",
          port: 6380,
          key: "tasks",
          direction: "left",
          max_length: 100,
          password: "secret",
          db: 2,
          max_retries: 9,
          connect_timeout: 1234,
          command_timeout: 4321,
          keep_alive: 111,
          lazy_connect: true,
          max_retries_per_request: 15,
          enable_offline_queue: false,
        },
      },
    });

    await loadAndBuild(configPath);

    expect(createRedisListOutputMock).toHaveBeenCalledTimes(1);
    expect(createRedisListOutputMock).toHaveBeenCalledWith({
      host: "redis.example",
      port: 6380,
      key: "tasks",
      direction: "left",
      maxLen: 100,
      password: "secret",
      db: 2,
      maxRetries: 9,
      connectTimeout: 1234,
      commandTimeout: 4321,
      keepAlive: 111,
      lazyConnect: true,
      maxRetriesPerRequest: 15,
      enableOfflineQueue: false,
    });
  });

  it("forwards Redis pubsub output reliability YAML to createRedisPubSubOutput", async () => {
    const configPath = await writeTempYaml({
      input: {
        generate: {
          count: 1,
          template: { ok: true },
        },
      },
      output: {
        redis_pubsub: {
          host: "pubsub.example",
          port: 6381,
          channel: "events",
          password: "pw",
          db: 3,
          max_retries: 4,
          connect_timeout: 1500,
          command_timeout: 2500,
          keep_alive: 45000,
          lazy_connect: true,
          max_retries_per_request: 8,
          enable_offline_queue: false,
        },
      },
    });

    await loadAndBuild(configPath);

    expect(createRedisPubSubOutputMock).toHaveBeenCalledTimes(1);
    expect(createRedisPubSubOutputMock).toHaveBeenCalledWith({
      host: "pubsub.example",
      port: 6381,
      channel: "events",
      password: "pw",
      db: 3,
      maxRetries: 4,
      connectTimeout: 1500,
      commandTimeout: 2500,
      keepAlive: 45000,
      lazyConnect: true,
      maxRetriesPerRequest: 8,
      enableOfflineQueue: false,
    });
  });

  it("forwards Redis streams output reliability YAML to createRedisStreamsOutput", async () => {
    const configPath = await writeTempYaml({
      input: {
        generate: {
          count: 1,
          template: { ok: true },
        },
      },
      output: {
        redis_streams: {
          url: "redis://:stream-secret@streams.example:6390/4",
          stream: "events",
          max_length: 2500,
          max_retries: 8,
          connect_timeout: 1700,
          command_timeout: 2700,
          keep_alive: 35000,
          lazy_connect: true,
          max_retries_per_request: 11,
          enable_offline_queue: false,
        },
      },
    });

    await loadAndBuild(configPath);

    expect(createRedisStreamsOutputMock).toHaveBeenCalledTimes(1);
    expect(createRedisStreamsOutputMock).toHaveBeenCalledWith({
      host: "streams.example",
      port: 6390,
      stream: "events",
      maxLen: 2500,
      password: "stream-secret",
      db: 4,
      maxRetries: 8,
      connectTimeout: 1700,
      commandTimeout: 2700,
      keepAlive: 35000,
      lazyConnect: true,
      maxRetriesPerRequest: 11,
      enableOfflineQueue: false,
    });
  });

  it.each(["%%%not-a-url%%%", "http://streams.example:6379/2"])(
    "rejects malformed Redis streams output URL %s without calling factory",
    async (url) => {
      const configPath = await writeTempYaml({
        input: {
          generate: {
            count: 1,
            template: { ok: true },
          },
        },
        output: {
          redis_streams: {
            url,
            stream: "events",
          },
        },
      });

      const config = await Effect.runPromise(loadConfig(configPath));
      const result = await Effect.runPromise(
        Effect.either(buildPipeline(config)),
      );

      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left).toBeInstanceOf(BuildError);
        expect(result.left._tag).toBe("BuildError");
        expect(result.left.message).toBe("Invalid Redis Streams output URL");
      }
      expect(createRedisStreamsOutputMock).not.toHaveBeenCalled();
    },
  );

  it("loads configs/advanced-connection.yaml reliability values into factories", async () => {
    await loadAndBuild("configs/advanced-connection.yaml");

    expect(createSqsInputMock).toHaveBeenCalledTimes(1);
    expect(createSqsInputMock).toHaveBeenCalledWith({
      queueUrl: "http://localhost:4566/000000000000/input-queue",
      region: "us-east-1",
      endpoint: "http://localhost:4566",
      waitTimeSeconds: 20,
      maxMessages: 10,
      maxAttempts: 5,
      requestTimeout: 30000,
      connectionTimeout: 5000,
    });

    expect(createRedisStreamsOutputMock).toHaveBeenCalledTimes(1);
    expect(createRedisStreamsOutputMock).toHaveBeenCalledWith({
      host: "localhost",
      port: 6379,
      stream: "processed-messages",
      maxLen: 10000,
      password: undefined,
      db: undefined,
      maxRetries: 5,
      connectTimeout: 10000,
      commandTimeout: 5000,
      keepAlive: 30000,
      lazyConnect: false,
      maxRetriesPerRequest: 20,
      enableOfflineQueue: true,
    });
  });

  it("still rejects unknown top-level fields under strict decoding", async () => {
    const configPath = await writeTempYaml({
      input: {
        aws_sqs: {
          url: "http://localhost:4566/000000000000/input-queue",
          region: "us-east-1",
          max_attempts: 5,
        },
      },
      output: {
        capture: {},
      },
      totally_unknown_top_level: true,
    });

    const result = await Effect.runPromise(
      Effect.either(loadConfig(configPath)),
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("ConfigValidationError");
      expect(String(result.left.message)).toMatch(
        /totally_unknown_top_level|excess|Unexpected/i,
      );
    }
    expect(createSqsInputMock).not.toHaveBeenCalled();
  });
});
