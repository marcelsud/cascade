import { describe, it, expect, vi, beforeEach } from "vitest";
import { Effect } from "effect";
import Redis from "ioredis";
import { createRedisPubSubInput } from "../../../src/inputs/redis-pubsub-input.js";

// Mock ioredis
vi.mock("ioredis", () => {
  return {
    default: vi.fn(() => ({
      status: "ready",
      subscribe: vi.fn().mockResolvedValue(null),
      psubscribe: vi.fn().mockResolvedValue(null),
      unsubscribe: vi.fn().mockResolvedValue(null),
      punsubscribe: vi.fn().mockResolvedValue(null),
      quit: vi.fn().mockResolvedValue("OK"),
      disconnect: vi.fn(),
      on: vi.fn(),
    })),
  };
});

describe("RedisPubSubInput", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Configuration", () => {
    it("should create input with channels", () => {
      const input = createRedisPubSubInput({
        host: "localhost",
        port: 6379,
        channels: ["events", "notifications"],
      });

      expect(input.name).toBe("redis-pubsub-input");
      expect(input.stream).toBeDefined();
      expect(input.close).toBeDefined();
    });

    it("should create input with patterns", () => {
      const input = createRedisPubSubInput({
        host: "localhost",
        port: 6379,
        patterns: ["events:*", "logs:*"],
      });

      expect(input).toBeDefined();
    });

    it("should create input with both channels and patterns", () => {
      const input = createRedisPubSubInput({
        host: "localhost",
        port: 6379,
        channels: ["global"],
        patterns: ["user:*"],
      });

      expect(input).toBeDefined();
    });

    it("should support connection options", () => {
      const input = createRedisPubSubInput({
        host: "localhost",
        port: 6379,
        channels: ["test"],
        password: "secret",
        db: 2,
      });

      expect(input).toBeDefined();
    });

    it("should support queue size configuration", () => {
      const input = createRedisPubSubInput({
        host: "localhost",
        port: 6379,
        channels: ["test"],
        queueSize: 50,
      });

      expect(input).toBeDefined();
    });
  });

  describe("Validation", () => {
    it("should fail when neither channels nor patterns provided", () => {
      expect(() =>
        createRedisPubSubInput({
          host: "localhost",
          port: 6379,
        }),
      ).toThrow(/requires at least one channel or pattern/);
    });

    it("should fail when channels is empty array", () => {
      expect(() =>
        createRedisPubSubInput({
          host: "localhost",
          port: 6379,
          channels: [],
        }),
      ).toThrow();
    });

    it("should fail when patterns is empty array", () => {
      expect(() =>
        createRedisPubSubInput({
          host: "localhost",
          port: 6379,
          patterns: [],
        }),
      ).toThrow();
    });

    it("should validate hostname format", () => {
      expect(() =>
        createRedisPubSubInput({
          host: "",
          port: 6379,
          channels: ["test"],
        }),
      ).toThrow();
    });

    it("should validate port range", () => {
      expect(() =>
        createRedisPubSubInput({
          host: "localhost",
          port: 99999,
          channels: ["test"],
        }),
      ).toThrow();
    });

    it("should validate channel names are non-empty", () => {
      expect(() =>
        createRedisPubSubInput({
          host: "localhost",
          port: 6379,
          channels: [""],
        }),
      ).toThrow();
    });
  });

  describe("Close", () => {
    it("should have close function", async () => {
      const input = createRedisPubSubInput({
        host: "localhost",
        port: 6379,
        channels: ["test"],
      });

      expect(input.close).toBeDefined();

      if (input.close) {
        await Effect.runPromise(input.close());
      }
    });

    it("disconnects an unready subscriber without unsubscribing", async () => {
      const disconnect = vi.fn();
      const quit = vi.fn().mockResolvedValue("OK");
      const unsubscribe = vi.fn().mockResolvedValue(null);
      const punsubscribe = vi.fn().mockResolvedValue(null);
      const redisMock = Redis as unknown as {
        mockImplementationOnce: (factory: () => never) => void;
      };
      redisMock.mockImplementationOnce(
        () =>
          ({
            status: "wait",
            subscribe: vi.fn().mockResolvedValue(null),
            psubscribe: vi.fn().mockResolvedValue(null),
            unsubscribe,
            punsubscribe,
            quit,
            disconnect,
            on: vi.fn(),
          }) as never,
      );
      const input = createRedisPubSubInput({
        host: "localhost",
        port: 6379,
        channels: ["test"],
        lazyConnect: true,
      });

      await Effect.runPromise(input.close!());

      expect(disconnect).toHaveBeenCalledOnce();
      expect(quit).not.toHaveBeenCalled();
      expect(unsubscribe).not.toHaveBeenCalled();
      expect(punsubscribe).not.toHaveBeenCalled();
    });
  });
});
