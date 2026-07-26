import { describe, it, expect, vi, beforeEach } from "vitest";
import { Chunk, Effect, Either, Option, Stream } from "effect";
import Redis from "ioredis";
import {
  createRedisStreamsInput,
  RedisStreamsInputError,
} from "../../../src/inputs/redis-streams-input.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Message } from "../../../src/core/types.js";

// Mock ioredis
vi.mock("ioredis", () => {
  return {
    default: vi.fn(() => ({
      status: "ready",
      xread: vi.fn().mockResolvedValue(null),
      xreadgroup: vi.fn().mockResolvedValue(null),
      xgroup: vi.fn().mockResolvedValue("OK"),
      xack: vi.fn().mockResolvedValue(1),
      quit: vi.fn().mockResolvedValue("OK"),
      disconnect: vi.fn(),
      on: vi.fn(),
    })),
  };
});

type MockFn = ReturnType<typeof vi.fn>;

type MockRedisClient = {
  status: string;
  xread: MockFn;
  xreadgroup: MockFn;
  xgroup: MockFn;
  xack: MockFn;
  quit: MockFn;
  disconnect: MockFn;
  on: MockFn;
};

/** Client instance constructed by the most recent `createRedisStreamsInput` call. */
const factoryOwnedClient = (): MockRedisClient => {
  const result = vi.mocked(Redis).mock.results.at(-1);
  if (!result || result.type !== "return") {
    throw new Error("expected Redis mock client from createRedisStreamsInput");
  }
  return result.value as MockRedisClient;
};

const entryFields = (
  content: string = JSON.stringify({ test: "data" }),
  extras: string[] = [
    "metadata",
    JSON.stringify({ origin: "test" }),
    "timestamp",
    "1234567890",
    "correlationId",
    "test-corr-id",
  ],
): string[] => ["content", content, ...extras];

const xreadPayload = (
  streamName: string,
  entryId: string,
  fields: string[] = entryFields(),
) => [[streamName, [[entryId, fields]]]];

describe("RedisStreamsInput", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Configuration", () => {
    it("should create input with simple mode by default", async () => {
      const input = createRedisStreamsInput({
        host: "localhost",
        port: 6379,
        stream: "test-stream",
        blockMs: 1,
        count: 1,
      });

      expect(input.name).toBe("redis-streams-input");
      expect(input.shutdownMode).toBe("finish-current");

      const mockClient = factoryOwnedClient();
      mockClient.xread.mockResolvedValueOnce(
        xreadPayload("test-stream", "1-0"),
      );

      const message = await Effect.runPromise(Stream.runHead(input.stream));
      expect(Option.isSome(message)).toBe(true);
      expect(mockClient.xread).toHaveBeenCalled();
      expect(mockClient.xreadgroup).not.toHaveBeenCalled();
      expect(mockClient.xgroup).not.toHaveBeenCalled();

      await Effect.runPromise(input.close!());
    });

    it("should create input with consumer group mode when specified", async () => {
      const input = createRedisStreamsInput({
        host: "localhost",
        port: 6379,
        stream: "test-stream",
        mode: "consumer-group",
        consumerGroup: "test-group",
        consumerName: "consumer-1",
        blockMs: 1,
        count: 1,
      });

      expect(input.shutdownMode).toBe("finish-current");

      const mockClient = factoryOwnedClient();
      mockClient.xreadgroup.mockResolvedValueOnce(
        xreadPayload("test-stream", "1-0"),
      );

      const message = await Effect.runPromise(Stream.runHead(input.stream));
      expect(Option.isSome(message)).toBe(true);
      expect(mockClient.xgroup).toHaveBeenCalled();
      expect(mockClient.xreadgroup).toHaveBeenCalled();
      expect(mockClient.xread).not.toHaveBeenCalled();

      await Effect.runPromise(input.close!());
    });

    it("should auto-detect consumer group mode from config", async () => {
      const input = createRedisStreamsInput({
        host: "localhost",
        port: 6379,
        stream: "test-stream",
        consumerGroup: "test-group", // Presence triggers consumer group mode
        consumerName: "consumer-1",
        blockMs: 1,
        count: 1,
      });

      const mockClient = factoryOwnedClient();
      mockClient.xreadgroup.mockResolvedValueOnce(
        xreadPayload("test-stream", "1-0"),
      );

      const message = await Effect.runPromise(Stream.runHead(input.stream));
      expect(Option.isSome(message)).toBe(true);
      expect(mockClient.xgroup).toHaveBeenCalledWith(
        "CREATE",
        "test-stream",
        "test-group",
        "$",
        "MKSTREAM",
      );
      expect(mockClient.xreadgroup).toHaveBeenCalled();
      expect(mockClient.xread).not.toHaveBeenCalled();

      await Effect.runPromise(input.close!());
    });

    it("should support connection options", () => {
      createRedisStreamsInput({
        host: "localhost",
        port: 6379,
        stream: "test-stream",
        password: "secret",
        db: 2,
      });

      expect(vi.mocked(Redis)).toHaveBeenCalledWith(
        expect.objectContaining({
          host: "localhost",
          port: 6379,
          password: "secret",
          db: 2,
        }),
      );
    });
  });

  describe("Simple Mode", () => {
    it("exposes a stream and close lifecycle for simple mode", () => {
      const input = createRedisStreamsInput({
        host: "localhost",
        port: 6379,
        stream: "test-stream",
        mode: "simple",
      });

      expect(input.stream).toBeDefined();
      expect(input.close).toBeDefined();
    });

    it("should handle empty poll results", async () => {
      const input = createRedisStreamsInput({
        host: "localhost",
        port: 6379,
        stream: "test-stream",
        mode: "simple",
        blockMs: 1,
        count: 1,
        startId: "0",
      });

      const mockClient = factoryOwnedClient();
      mockClient.xread
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(xreadPayload("test-stream", "10-0"));

      const message = await Effect.runPromise(Stream.runHead(input.stream));

      expect(Option.isSome(message)).toBe(true);
      if (Option.isSome(message)) {
        expect(message.value.content).toEqual({ test: "data" });
      }
      expect(mockClient.xread).toHaveBeenCalledTimes(2);

      await Effect.runPromise(input.close!());
    });

    it("should convert Redis entries to Messages", async () => {
      const entryId = "1234567890-0";
      const streamName = "test-stream";

      const input = createRedisStreamsInput({
        host: "localhost",
        port: 6379,
        stream: streamName,
        mode: "simple",
        blockMs: 1,
        count: 1,
        startId: "0",
      });

      const mockClient = factoryOwnedClient();
      mockClient.xread.mockResolvedValueOnce(
        xreadPayload(streamName, entryId, entryFields()),
      );

      const message = await Effect.runPromise(Stream.runHead(input.stream));

      expect(Option.isSome(message)).toBe(true);
      if (Option.isNone(message)) {
        throw new Error("expected a simple-mode message");
      }

      expect(message.value.content).toEqual({ test: "data" });
      expect(message.value.metadata.externalId).toBe(entryId);
      expect(message.value.metadata.streamName).toBe(streamName);
      expect(message.value.metadata.source).toBe("redis-streams-input");
      expect(message.value.metadata.origin).toBe("test");
      expect(message.value.correlationId).toBe("test-corr-id");
      expect(message.value.timestamp).toBe(1234567890);
      expect(mockClient.xread).toHaveBeenCalledTimes(1);

      await Effect.runPromise(input.close!());
    });

    it("should update last ID after reading", async () => {
      const streamName = "test-stream";
      const firstId = "111-0";
      const secondId = "222-0";

      const input = createRedisStreamsInput({
        host: "localhost",
        port: 6379,
        stream: streamName,
        mode: "simple",
        startId: "0",
        blockMs: 1,
        count: 1,
      });

      const mockClient = factoryOwnedClient();
      mockClient.xread
        .mockResolvedValueOnce(
          xreadPayload(
            streamName,
            firstId,
            entryFields(JSON.stringify({ n: 1 })),
          ),
        )
        .mockResolvedValueOnce(
          xreadPayload(
            streamName,
            secondId,
            entryFields(JSON.stringify({ n: 2 })),
          ),
        );

      const chunk = await Effect.runPromise(
        Stream.runCollect(input.stream.pipe(Stream.take(2))),
      );
      const messages = Chunk.toReadonlyArray(chunk);

      expect(messages).toHaveLength(2);
      expect(messages[0]?.content).toEqual({ n: 1 });
      expect(messages[1]?.content).toEqual({ n: 2 });

      expect(mockClient.xread).toHaveBeenCalledTimes(2);
      expect(mockClient.xread.mock.calls[0]).toEqual([
        "COUNT",
        1,
        "BLOCK",
        1,
        "STREAMS",
        streamName,
        "0",
      ]);
      expect(mockClient.xread.mock.calls[1]).toEqual([
        "COUNT",
        1,
        "BLOCK",
        1,
        "STREAMS",
        streamName,
        firstId,
      ]);

      await Effect.runPromise(input.close!());
    });
  });

  describe("Consumer Group Mode", () => {
    it("should create consumer group if not exists", async () => {
      const streamName = "test-stream";
      const groupName = "test-group";
      const consumerName = "consumer-1";

      const input = createRedisStreamsInput({
        host: "localhost",
        port: 6379,
        stream: streamName,
        mode: "consumer-group",
        consumerGroup: groupName,
        consumerName,
        startId: "0",
        blockMs: 1,
        count: 1,
      });

      const mockClient = factoryOwnedClient();
      mockClient.xreadgroup.mockResolvedValueOnce(
        xreadPayload(streamName, "1-0"),
      );

      const message = await Effect.runPromise(Stream.runHead(input.stream));
      expect(Option.isSome(message)).toBe(true);

      expect(mockClient.xgroup).toHaveBeenCalledWith(
        "CREATE",
        streamName,
        groupName,
        "0",
        "MKSTREAM",
      );
      expect(mockClient.xreadgroup).toHaveBeenCalledWith(
        "GROUP",
        groupName,
        consumerName,
        "COUNT",
        1,
        "BLOCK",
        1,
        "STREAMS",
        streamName,
        ">",
      );

      await Effect.runPromise(input.close!());
    });

    it("should handle existing consumer group", async () => {
      const streamName = "test-stream";
      const groupName = "existing-group";
      const entryId = "55-0";

      const input = createRedisStreamsInput({
        host: "localhost",
        port: 6379,
        stream: streamName,
        mode: "consumer-group",
        consumerGroup: groupName,
        consumerName: "consumer-1",
        blockMs: 1,
        count: 1,
      });

      const mockClient = factoryOwnedClient();
      // Simulate BUSYGROUP error (group already exists)
      mockClient.xgroup.mockRejectedValueOnce({
        message: "BUSYGROUP Consumer Group name already exists",
      });
      mockClient.xreadgroup.mockResolvedValueOnce(
        xreadPayload(
          streamName,
          entryId,
          entryFields(JSON.stringify({ kept: true })),
        ),
      );

      const message = await Effect.runPromise(Stream.runHead(input.stream));

      expect(Option.isSome(message)).toBe(true);
      if (Option.isSome(message)) {
        expect(message.value.content).toEqual({ kept: true });
        expect(message.value.metadata.externalId).toBe(entryId);
      }
      expect(mockClient.xgroup).toHaveBeenCalledTimes(1);
      expect(mockClient.xreadgroup).toHaveBeenCalledTimes(1);

      await Effect.runPromise(input.close!());
    });

    it("defers XACK until Message.ack is invoked", async () => {
      const RedisCtor = (await import("ioredis")).default as unknown as {
        mock: { results: Array<{ value: Record<string, any> }> };
      };

      const entryId = "1234567890-0";
      const streamName = "test-stream";
      const groupName = "test-group";

      const input = createRedisStreamsInput({
        host: "localhost",
        port: 6379,
        stream: streamName,
        mode: "consumer-group",
        consumerGroup: groupName,
        consumerName: "consumer-1",
        blockMs: 1,
        count: 1,
      });

      const mockClient = RedisCtor.mock.results.at(-1)!.value;
      mockClient.xreadgroup.mockResolvedValueOnce([
        [
          streamName,
          [
            [
              entryId,
              [
                "content",
                JSON.stringify({ test: "data" }),
                "metadata",
                "{}",
                "timestamp",
                "1234567890",
              ],
            ],
          ],
        ],
      ]);

      const message = await Effect.runPromise(
        Stream.runHead(input.stream).pipe(Effect.map((opt) => opt)),
      );

      expect(message._tag).toBe("Some");
      if (message._tag !== "Some") {
        throw new Error("expected a consumer-group message");
      }

      expect(message.value.ack).toEqual(expect.any(Function));
      expect(mockClient.xack).not.toHaveBeenCalled();

      await Effect.runPromise(message.value.ack!());

      expect(mockClient.xack).toHaveBeenCalledOnce();
      expect(mockClient.xack).toHaveBeenCalledWith(
        streamName,
        groupName,
        entryId,
      );

      await Effect.runPromise(input.close!());
    });

    it("should generate consumer name if not provided", async () => {
      const streamName = "test-stream";
      const groupName = "test-group";

      const input = createRedisStreamsInput({
        host: "localhost",
        port: 6379,
        stream: streamName,
        mode: "consumer-group",
        consumerGroup: groupName,
        // consumerName not provided - should be auto-generated
        blockMs: 1,
        count: 1,
      });

      const mockClient = factoryOwnedClient();
      mockClient.xreadgroup.mockResolvedValueOnce(
        xreadPayload(streamName, "1-0"),
      );

      const message = await Effect.runPromise(Stream.runHead(input.stream));
      expect(Option.isSome(message)).toBe(true);

      const consumerName = mockClient.xreadgroup.mock.calls[0]?.[2];
      expect(consumerName).toMatch(/^consumer-[a-z0-9]+$/);
      expect(mockClient.xreadgroup).toHaveBeenCalledWith(
        "GROUP",
        groupName,
        consumerName,
        "COUNT",
        1,
        "BLOCK",
        1,
        "STREAMS",
        streamName,
        ">",
      );

      await Effect.runPromise(input.close!());
    });
  });

  describe("Error Handling", () => {
    it("constructs input for an unreachable host without throwing", () => {
      const input = createRedisStreamsInput({
        host: "invalid-host",
        port: 6379,
        stream: "test-stream",
      });

      expect(input.name).toBe("redis-streams-input");
      expect(input.stream).toEqual(expect.any(Object));
      expect(input.close).toEqual(expect.any(Function));
    });

    it("should handle parsing errors for malformed entries", async () => {
      const entryId = "1234567890-0";
      const streamName = "test-stream";

      const input = createRedisStreamsInput({
        host: "localhost",
        port: 6379,
        stream: streamName,
        mode: "simple",
        blockMs: 1,
        count: 1,
        startId: "0",
      });

      const mockClient = factoryOwnedClient();
      mockClient.xread.mockResolvedValueOnce(
        xreadPayload(streamName, entryId, [
          "content",
          "invalid-json",
          "metadata",
          "{}",
        ]),
      );

      const message = await Effect.runPromise(Stream.runHead(input.stream));

      expect(Option.isSome(message)).toBe(true);
      if (Option.isSome(message)) {
        expect(message.value.content).toEqual({ raw: "invalid-json" });
        expect(message.value.metadata.externalId).toBe(entryId);
        expect(message.value.metadata.source).toBe("redis-streams-input");
      }

      await Effect.runPromise(input.close!());
    });

    it("should retry after errors", async () => {
      const streamName = "test-stream";
      const entryId = "99-0";

      const input = createRedisStreamsInput({
        host: "localhost",
        port: 6379,
        stream: streamName,
        mode: "simple",
        blockMs: 1,
        count: 1,
        startId: "0",
        reconnectBackoffMs: 1,
      });

      const mockClient = factoryOwnedClient();
      mockClient.xread
        .mockRejectedValueOnce(new Error("ECONNREFUSED connection refused"))
        .mockResolvedValueOnce(
          xreadPayload(
            streamName,
            entryId,
            entryFields(JSON.stringify({ recovered: true })),
          ),
        );

      const message = await Effect.runPromise(Stream.runHead(input.stream));

      expect(Option.isSome(message)).toBe(true);
      if (Option.isSome(message)) {
        expect(message.value.content).toEqual({ recovered: true });
      }
      expect(mockClient.xread).toHaveBeenCalledTimes(2);

      await Effect.runPromise(input.close!());
    });

    it("propagates a fatal simple-read error without a second Redis operation", async () => {
      const xread = vi
        .fn()
        .mockRejectedValueOnce(new Error("NOAUTH Authentication required."))
        .mockResolvedValueOnce(null);
      const redisMock = Redis as unknown as {
        mockImplementationOnce: (factory: () => never) => void;
      };
      redisMock.mockImplementationOnce(
        () =>
          ({
            status: "ready",
            xread,
            xreadgroup: vi.fn().mockResolvedValue(null),
            xgroup: vi.fn().mockResolvedValue("OK"),
            xack: vi.fn().mockResolvedValue(1),
            quit: vi.fn().mockResolvedValue("OK"),
            disconnect: vi.fn(),
            on: vi.fn(),
          }) as never,
      );

      const input = createRedisStreamsInput({
        host: "localhost",
        port: 6379,
        stream: "test-stream",
        mode: "simple",
        reconnectBackoffMs: 1,
      });

      const result = await Effect.runPromise(
        Effect.either(Stream.runHead(input.stream)),
      );

      expect(xread).toHaveBeenCalledTimes(1);
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left).toBeInstanceOf(RedisStreamsInputError);
        expect((result.left as RedisStreamsInputError).category).toBe("fatal");
      }
    });

    it("propagates a fatal consumer-group init error without a second Redis operation", async () => {
      const xgroup = vi
        .fn()
        .mockRejectedValueOnce(new Error("NOAUTH Authentication required."))
        .mockResolvedValueOnce("OK");
      const xreadgroup = vi.fn().mockResolvedValue(null);
      const redisMock = Redis as unknown as {
        mockImplementationOnce: (factory: () => never) => void;
      };
      redisMock.mockImplementationOnce(
        () =>
          ({
            status: "ready",
            xread: vi.fn().mockResolvedValue(null),
            xreadgroup,
            xgroup,
            xack: vi.fn().mockResolvedValue(1),
            quit: vi.fn().mockResolvedValue("OK"),
            disconnect: vi.fn(),
            on: vi.fn(),
          }) as never,
      );

      const input = createRedisStreamsInput({
        host: "localhost",
        port: 6379,
        stream: "test-stream",
        mode: "consumer-group",
        consumerGroup: "test-group",
        consumerName: "consumer-1",
        reconnectBackoffMs: 1,
      });

      const result = await Effect.runPromise(
        Effect.either(Stream.runHead(input.stream)),
      );

      expect(xgroup).toHaveBeenCalledTimes(1);
      expect(xreadgroup).not.toHaveBeenCalled();
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left).toBeInstanceOf(RedisStreamsInputError);
        expect((result.left as RedisStreamsInputError).category).toBe("fatal");
      }
    });

    it("propagates a fatal consumer-group read error without a second Redis operation", async () => {
      const xgroup = vi.fn().mockResolvedValue("OK");
      const xreadgroup = vi
        .fn()
        .mockRejectedValueOnce(new Error("NOAUTH Authentication required."))
        .mockResolvedValueOnce(null);
      const redisMock = Redis as unknown as {
        mockImplementationOnce: (factory: () => never) => void;
      };
      redisMock.mockImplementationOnce(
        () =>
          ({
            status: "ready",
            xread: vi.fn().mockResolvedValue(null),
            xreadgroup,
            xgroup,
            xack: vi.fn().mockResolvedValue(1),
            quit: vi.fn().mockResolvedValue("OK"),
            disconnect: vi.fn(),
            on: vi.fn(),
          }) as never,
      );

      const input = createRedisStreamsInput({
        host: "localhost",
        port: 6379,
        stream: "test-stream",
        mode: "consumer-group",
        consumerGroup: "test-group",
        consumerName: "consumer-1",
        reconnectBackoffMs: 1,
      });

      const result = await Effect.runPromise(
        Effect.either(Stream.runHead(input.stream)),
      );

      expect(xgroup).toHaveBeenCalledTimes(1);
      expect(xreadgroup).toHaveBeenCalledTimes(1);
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left).toBeInstanceOf(RedisStreamsInputError);
        expect((result.left as RedisStreamsInputError).category).toBe("fatal");
      }
    });
  });

  describe("Read Configuration", () => {
    it("should use custom block timeout", async () => {
      const input = createRedisStreamsInput({
        host: "localhost",
        port: 6379,
        stream: "test-stream",
        mode: "simple",
        blockMs: 10000,
        count: 1,
        startId: "0",
      });

      const mockClient = factoryOwnedClient();
      mockClient.xread.mockResolvedValueOnce(
        xreadPayload("test-stream", "1-0"),
      );

      await Effect.runPromise(Stream.runHead(input.stream));

      expect(mockClient.xread).toHaveBeenCalledWith(
        "COUNT",
        1,
        "BLOCK",
        10000,
        "STREAMS",
        "test-stream",
        "0",
      );

      await Effect.runPromise(input.close!());
    });

    it("should use custom message count", async () => {
      const input = createRedisStreamsInput({
        host: "localhost",
        port: 6379,
        stream: "test-stream",
        mode: "simple",
        blockMs: 1,
        count: 50,
        startId: "0",
      });

      const mockClient = factoryOwnedClient();
      mockClient.xread.mockResolvedValueOnce(
        xreadPayload("test-stream", "1-0"),
      );

      await Effect.runPromise(Stream.runHead(input.stream));

      expect(mockClient.xread).toHaveBeenCalledWith(
        "COUNT",
        50,
        "BLOCK",
        1,
        "STREAMS",
        "test-stream",
        "0",
      );

      await Effect.runPromise(input.close!());
    });

    it("should support custom start ID", async () => {
      const input = createRedisStreamsInput({
        host: "localhost",
        port: 6379,
        stream: "test-stream",
        mode: "simple",
        blockMs: 1,
        count: 1,
        startId: "0", // Start from beginning
      });

      const mockClient = factoryOwnedClient();
      mockClient.xread.mockResolvedValueOnce(
        xreadPayload("test-stream", "1-0"),
      );

      await Effect.runPromise(Stream.runHead(input.stream));

      expect(mockClient.xread).toHaveBeenCalledWith(
        "COUNT",
        1,
        "BLOCK",
        1,
        "STREAMS",
        "test-stream",
        "0",
      );

      await Effect.runPromise(input.close!());
    });
  });

  describe("Resource Management", () => {
    it("should implement close method", async () => {
      const input = createRedisStreamsInput({
        host: "localhost",
        port: 6379,
        stream: "test-stream",
      });

      expect(input.close).toBeDefined();

      if (input.close) {
        await Effect.runPromise(input.close());
      }
    });

    it("should quit Redis connection on close", async () => {
      const input = createRedisStreamsInput({
        host: "localhost",
        port: 6379,
        stream: "test-stream",
      });

      const mockClient = factoryOwnedClient();
      expect(mockClient.status).toBe("ready");

      await Effect.runPromise(input.close!());

      expect(mockClient.quit).toHaveBeenCalledTimes(1);
      expect(mockClient.disconnect).not.toHaveBeenCalled();
    });

    it("disconnects an unready client without waiting for quit", async () => {
      const disconnect = vi.fn();
      const quit = vi.fn().mockResolvedValue("OK");
      const redisMock = Redis as unknown as {
        mockImplementationOnce: (factory: () => never) => void;
      };
      redisMock.mockImplementationOnce(
        () =>
          ({
            status: "wait",
            xread: vi.fn().mockResolvedValue(null),
            xreadgroup: vi.fn().mockResolvedValue(null),
            xgroup: vi.fn().mockResolvedValue("OK"),
            xack: vi.fn().mockResolvedValue(1),
            quit,
            disconnect,
            on: vi.fn(),
          }) as never,
      );
      const input = createRedisStreamsInput({
        host: "localhost",
        port: 6379,
        stream: "test-stream",
      });

      await Effect.runPromise(input.close!());

      expect(disconnect).toHaveBeenCalledOnce();
      expect(quit).not.toHaveBeenCalled();
    });
  });
});

const extractMessageMetadataSection = (markdown: string): string => {
  const match = markdown.match(/## Message Metadata\n([\s\S]*?)(?=\n## |\n*$)/);
  if (!match) {
    throw new Error("Message Metadata section not found");
  }
  return match[1];
};

const consumeOneRedisMessage = async (fields: string[]): Promise<Message> => {
  const input = createRedisStreamsInput({
    host: "localhost",
    port: 6379,
    stream: "test-stream",
    mode: "simple",
    blockMs: 1,
    count: 1,
  });

  const RedisCtor = (await import("ioredis")).default as unknown as {
    mock: { results: Array<{ value: Record<string, any> }> };
  };
  const mockClient = RedisCtor.mock.results.at(-1)!.value;
  mockClient.xread.mockResolvedValueOnce([
    ["test-stream", [["1234567890-0", fields]]],
  ]);

  const head = await Effect.runPromise(
    Stream.runHead(input.stream).pipe(Effect.map((opt) => opt)),
  );

  expect(head._tag).toBe("Some");
  if (head._tag !== "Some") {
    throw new Error("expected a redis streams message");
  }

  await Effect.runPromise(input.close!());
  return head.value;
};

describe("Redis Streams emitted message metadata contract", () => {
  it("emits source redis-streams-input and does not generate correlation IDs", async () => {
    const message = await consumeOneRedisMessage([
      "content",
      JSON.stringify({ test: "data" }),
      "metadata",
      "{}",
      "timestamp",
      "1234567890",
    ]);

    expect(message.metadata.source).toBe("redis-streams-input");
    expect(message.correlationId).toBeUndefined();
    expect(message.metadata.correlationId).toBeUndefined();
  });

  it("preserves a non-empty stream correlationId on the message envelope", async () => {
    const message = await consumeOneRedisMessage([
      "content",
      JSON.stringify({ test: "data" }),
      "metadata",
      "{}",
      "timestamp",
      "1234567890",
      "correlationId",
      "stream-corr-id",
    ]);

    expect(message.metadata.source).toBe("redis-streams-input");
    expect(message.correlationId).toBe("stream-corr-id");
    // Input preserves envelope correlationId only; it does not copy into metadata.
    expect(message.metadata.correlationId).toBeUndefined();
  });

  it("documents the same source and correlation contract as runtime", async () => {
    const message = await consumeOneRedisMessage([
      "content",
      JSON.stringify({ test: "data" }),
      "metadata",
      "{}",
      "timestamp",
      "1234567890",
    ]);

    const docsPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../docs/inputs/redis-streams.md",
    );
    const section = extractMessageMetadataSection(
      readFileSync(docsPath, "utf8"),
    );

    const documentedSource = section.match(/`source`:\s*"([^"]+)"/)?.[1];
    expect(documentedSource).toBe(message.metadata.source);
    expect(documentedSource).toBe("redis-streams-input");
    expect(section).not.toMatch(
      /correlationId.*Auto-generated if not present/i,
    );
    expect(section).not.toMatch(/auto-generat/i);

    // Docs must not claim generation when runtime emits neither field.
    expect(message.correlationId).toBeUndefined();
    expect(message.metadata.correlationId).toBeUndefined();
    expect(section.toLowerCase()).toContain("metadata processor");
    expect(section.toLowerCase()).toMatch(/preserv/);
  });
});
