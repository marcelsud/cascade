import { describe, it, expect, vi, beforeEach } from "vitest";
import { Effect, Either, Stream } from "effect";
import Redis from "ioredis";
import { createRedisListInput } from "../../../src/inputs/redis-list-input.js";
import { RedisListInputError } from "../../../src/inputs/redis-list-input.js";
import { run } from "../../../src/core/pipeline.js";

// Mock ioredis
vi.mock("ioredis", () => {
  return {
    default: vi.fn(() => ({
      status: "ready",
      blpop: vi.fn().mockResolvedValue(null),
      brpop: vi.fn().mockResolvedValue(null),
      quit: vi.fn().mockResolvedValue("OK"),
      disconnect: vi.fn(),
      on: vi.fn(),
    })),
  };
});

describe("RedisListInput", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Configuration", () => {
    it("should create input with single key", () => {
      const input = createRedisListInput({
        host: "localhost",
        port: 6379,
        key: "tasks",
      });

      expect(input.name).toBe("redis-list-input");
      expect(input.stream).toBeDefined();
      expect(input.close).toBeDefined();
    });

    it("should create input with multiple keys", () => {
      const input = createRedisListInput({
        host: "localhost",
        port: 6379,
        key: ["high-priority", "low-priority"],
      });

      expect(input).toBeDefined();
    });

    it("should default to left direction (BLPOP)", () => {
      const input = createRedisListInput({
        host: "localhost",
        port: 6379,
        key: "tasks",
      });

      expect(input).toBeDefined();
    });

    it("should support right direction (BRPOP)", () => {
      const input = createRedisListInput({
        host: "localhost",
        port: 6379,
        key: "tasks",
        direction: "right",
      });

      expect(input).toBeDefined();
    });

    it("should support custom timeout", () => {
      const input = createRedisListInput({
        host: "localhost",
        port: 6379,
        key: "tasks",
        timeout: 10,
      });

      expect(input).toBeDefined();
    });

    it("should support connection options", () => {
      const input = createRedisListInput({
        host: "localhost",
        port: 6379,
        key: "tasks",
        password: "secret",
        db: 2,
      });

      expect(input).toBeDefined();
    });
  });

  describe("Validation", () => {
    it("should fail with empty key", () => {
      expect(() =>
        createRedisListInput({
          host: "localhost",
          port: 6379,
          key: "",
        }),
      ).toThrow();
    });

    it("should fail with empty key array", () => {
      expect(() =>
        createRedisListInput({
          host: "localhost",
          port: 6379,
          key: [],
        }),
      ).toThrow();
    });

    it("should validate hostname format", () => {
      expect(() =>
        createRedisListInput({
          host: "",
          port: 6379,
          key: "tasks",
        }),
      ).toThrow();
    });

    it("should validate port range", () => {
      expect(() =>
        createRedisListInput({
          host: "localhost",
          port: 99999,
          key: "tasks",
        }),
      ).toThrow();
    });

    it("should validate timeout is positive", () => {
      expect(() =>
        createRedisListInput({
          host: "localhost",
          port: 6379,
          key: "tasks",
          timeout: -1,
        }),
      ).toThrow();
    });
  });

  describe("Direction", () => {
    it("should accept left direction", () => {
      expect(() =>
        createRedisListInput({
          host: "localhost",
          port: 6379,
          key: "tasks",
          direction: "left",
        }),
      ).not.toThrow();
    });

    it("should accept right direction", () => {
      expect(() =>
        createRedisListInput({
          host: "localhost",
          port: 6379,
          key: "tasks",
          direction: "right",
        }),
      ).not.toThrow();
    });
  });

  describe("Close", () => {
    it("should have close function", async () => {
      const input = createRedisListInput({
        host: "localhost",
        port: 6379,
        key: "tasks",
      });

      expect(input.close).toBeDefined();

      if (input.close) {
        await Effect.runPromise(input.close());
      }
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
            blpop: vi.fn().mockResolvedValue(null),
            brpop: vi.fn().mockResolvedValue(null),
            quit,
            disconnect,
            on: vi.fn(),
          }) as never,
      );
      const input = createRedisListInput({
        host: "localhost",
        port: 6379,
        key: "tasks",
      });

      await Effect.runPromise(input.close!());

      expect(disconnect).toHaveBeenCalledOnce();
      expect(quit).not.toHaveBeenCalled();
    });
  });

  it("fails the stream with a typed error after reconnect exhaustion", async () => {
    const redisMock = Redis as unknown as {
      mockImplementationOnce: (factory: () => never) => void;
    };
    redisMock.mockImplementationOnce(
      () =>
        ({
          status: "ready",
          blpop: vi.fn().mockRejectedValue(new Error("offline")),
          brpop: vi.fn().mockRejectedValue(new Error("offline")),
          quit: vi.fn().mockResolvedValue("OK"),
          disconnect: vi.fn(),
          on: vi.fn(),
        }) as never,
    );
    const input = createRedisListInput({
      host: "localhost",
      port: 6379,
      key: "tasks",
      maxReconnectAttempts: 0,
      reconnectBackoffMs: 1,
    });

    const result = await Effect.runPromise(
      Effect.either(Stream.runHead(input.stream)),
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(RedisListInputError);
    }

    const pipelineResult = await Effect.runPromise(
      run({
        name: "redis-exhaustion-test",
        input,
        processors: [],
        output: { name: "unused", send: () => Effect.void },
      }),
    );
    expect(pipelineResult.success).toBe(false);
    expect(pipelineResult.errors?.[0]).toBeInstanceOf(RedisListInputError);
  });
});
