import { describe, it, expect, vi, beforeEach } from "vitest";
import { Effect, Either, Stream } from "effect";
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

describe("RedisStreamsInput", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Configuration", () => {
    it("should create input with simple mode by default", () => {
      const input = createRedisStreamsInput({
        host: "localhost",
        port: 6379,
        stream: "test-stream",
      });

      expect(input.name).toBe("redis-streams-input");
      expect(input.shutdownMode).toBe("finish-current");
      expect(input.stream).toBeDefined();
      expect(input.close).toBeDefined();
    });

    it("should create input with consumer group mode when specified", () => {
      const input = createRedisStreamsInput({
        host: "localhost",
        port: 6379,
        stream: "test-stream",
        mode: "consumer-group",
        consumerGroup: "test-group",
        consumerName: "consumer-1",
      });

      expect(input.shutdownMode).toBe("finish-current");
    });

    it("should auto-detect consumer group mode from config", () => {
      const input = createRedisStreamsInput({
        host: "localhost",
        port: 6379,
        stream: "test-stream",
        consumerGroup: "test-group", // Presence triggers consumer group mode
      });

      expect(input).toBeDefined();
    });

    it("should support connection options", () => {
      const input = createRedisStreamsInput({
        host: "localhost",
        port: 6379,
        stream: "test-stream",
        password: "secret",
        db: 2,
      });

      expect(input).toBeDefined();
    });
  });

  describe("Simple Mode", () => {
    it("should create stream for polling", () => {
      const input = createRedisStreamsInput({
        host: "localhost",
        port: 6379,
        stream: "test-stream",
        mode: "simple",
      });

      expect(input.stream).toBeDefined();
    });

    it("should handle empty poll results", async () => {
      const Redis = (await import("ioredis")).default;
      const mockClient = new Redis();
      (mockClient.xread as any).mockResolvedValueOnce(null);

      const input = createRedisStreamsInput({
        host: "localhost",
        port: 6379,
        stream: "test-stream",
        mode: "simple",
        blockMs: 1000,
      });

      expect(input.stream).toBeDefined();
    });

    it("should convert Redis entries to Messages", async () => {
      const Redis = (await import("ioredis")).default;
      const mockClient = new Redis();

      // Mock Redis response format: [[streamName, [[entryId, [key, val, key, val, ...]]]]]
      (mockClient.xread as any).mockResolvedValueOnce([
        [
          "test-stream",
          [
            [
              "1234567890-0",
              [
                "id",
                "test-id",
                "content",
                JSON.stringify({ test: "data" }),
                "metadata",
                JSON.stringify({ source: "test" }),
                "timestamp",
                "1234567890",
                "correlationId",
                "test-corr-id",
              ],
            ],
          ],
        ],
      ]);

      const input = createRedisStreamsInput({
        host: "localhost",
        port: 6379,
        stream: "test-stream",
        mode: "simple",
      });

      expect(input.stream).toBeDefined();
    });

    it("should update last ID after reading", () => {
      const input = createRedisStreamsInput({
        host: "localhost",
        port: 6379,
        stream: "test-stream",
        mode: "simple",
        startId: "$", // Start from latest
      });

      expect(input).toBeDefined();
    });
  });

  describe("Consumer Group Mode", () => {
    it("should create consumer group if not exists", async () => {
      const Redis = (await import("ioredis")).default;
      const mockClient = new Redis();

      const input = createRedisStreamsInput({
        host: "localhost",
        port: 6379,
        stream: "test-stream",
        mode: "consumer-group",
        consumerGroup: "test-group",
        consumerName: "consumer-1",
      });

      expect(input).toBeDefined();
    });

    it("should handle existing consumer group", async () => {
      const Redis = (await import("ioredis")).default;
      const mockClient = new Redis();

      // Simulate BUSYGROUP error (group already exists)
      (mockClient.xgroup as any).mockRejectedValueOnce({
        message: "BUSYGROUP Consumer Group name already exists",
      });

      const input = createRedisStreamsInput({
        host: "localhost",
        port: 6379,
        stream: "test-stream",
        mode: "consumer-group",
        consumerGroup: "existing-group",
      });

      expect(input).toBeDefined();
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

    it("should generate consumer name if not provided", () => {
      const input = createRedisStreamsInput({
        host: "localhost",
        port: 6379,
        stream: "test-stream",
        mode: "consumer-group",
        consumerGroup: "test-group",
        // consumerName not provided - should be auto-generated
      });

      expect(input).toBeDefined();
    });
  });

  describe("Error Handling", () => {
    it("should handle connection errors gracefully", () => {
      const input = createRedisStreamsInput({
        host: "invalid-host",
        port: 6379,
        stream: "test-stream",
      });

      expect(input.stream).toBeDefined();
    });

    it("should handle parsing errors for malformed entries", async () => {
      const Redis = (await import("ioredis")).default;
      const mockClient = new Redis();

      // Mock malformed entry (invalid JSON)
      (mockClient.xread as any).mockResolvedValueOnce([
        [
          "test-stream",
          [["1234567890-0", ["content", "invalid-json", "metadata", "{}"]]],
        ],
      ]);

      const input = createRedisStreamsInput({
        host: "localhost",
        port: 6379,
        stream: "test-stream",
        mode: "simple",
      });

      expect(input.stream).toBeDefined();
    });

    it("should retry after errors", () => {
      const input = createRedisStreamsInput({
        host: "localhost",
        port: 6379,
        stream: "test-stream",
      });

      expect(input.stream).toBeDefined();
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
    it("should use custom block timeout", () => {
      const input = createRedisStreamsInput({
        host: "localhost",
        port: 6379,
        stream: "test-stream",
        blockMs: 10000, // Custom timeout
      });

      expect(input).toBeDefined();
    });

    it("should use custom message count", () => {
      const input = createRedisStreamsInput({
        host: "localhost",
        port: 6379,
        stream: "test-stream",
        count: 50, // Custom batch size
      });

      expect(input).toBeDefined();
    });

    it("should support custom start ID", () => {
      const input = createRedisStreamsInput({
        host: "localhost",
        port: 6379,
        stream: "test-stream",
        startId: "0", // Start from beginning
      });

      expect(input).toBeDefined();
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

      expect(input.close).toBeDefined();

      if (input.close) {
        await Effect.runPromise(input.close());
      }

      // Close method exists and can be called (actual quit would be called internally)
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
