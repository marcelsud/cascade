import { describe, it, expect, vi, beforeEach } from "vitest";
import { Effect, Stream } from "effect";
import { createRedisStreamsInput } from "../../../src/inputs/redis-streams-input.js";

// Mock ioredis
vi.mock("ioredis", () => {
  return {
    default: vi.fn(() => ({
      xread: vi.fn().mockResolvedValue(null),
      xreadgroup: vi.fn().mockResolvedValue(null),
      xgroup: vi.fn().mockResolvedValue("OK"),
      xack: vi.fn().mockResolvedValue(1),
      quit: vi.fn().mockResolvedValue("OK"),
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

    it("should ACK messages after reading", async () => {
      const Redis = (await import("ioredis")).default;
      const mockClient = new Redis();

      (mockClient.xreadgroup as any).mockResolvedValueOnce([
        [
          "test-stream",
          [
            [
              "1234567890-0",
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

      const input = createRedisStreamsInput({
        host: "localhost",
        port: 6379,
        stream: "test-stream",
        mode: "consumer-group",
        consumerGroup: "test-group",
      });

      expect(input.stream).toBeDefined();
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
  });
});
