import { describe, it, expect, vi, beforeEach } from "vitest";
import { Effect, Logger, References } from "effect";
import Redis from "ioredis";
import { createRedisPubSubOutput } from "../../../src/outputs/redis-pubsub-output.js";
import type { Message } from "../../../src/core/types.js";

vi.mock("ioredis", () => {
  return {
    default: vi.fn(() => ({
      status: "ready",
      publish: vi.fn().mockResolvedValue(1),
      quit: vi.fn().mockResolvedValue("OK"),
      disconnect: vi.fn(),
      on: vi.fn(),
    })),
  };
});

const createMessage = (id: string, content: unknown = { id }): Message => ({
  id,
  content,
  metadata: {},
  timestamp: Date.now(),
  correlationId: `corr-${id}`,
});

describe("RedisPubSubOutput", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Configuration Validation", () => {
    it("should create output with valid configuration", () => {
      expect(() =>
        createRedisPubSubOutput({
          host: "localhost",
          port: 6379,
          channel: "events",
        }),
      ).not.toThrow();
    });

    it("should support channel template interpolation", () => {
      expect(() =>
        createRedisPubSubOutput({
          host: "localhost",
          port: 6379,
          channel: "events:{{content.type}}",
        }),
      ).not.toThrow();
    });

    it("should support password authentication", () => {
      expect(() =>
        createRedisPubSubOutput({
          host: "localhost",
          port: 6379,
          channel: "events",
          password: "secret",
        }),
      ).not.toThrow();
    });

    it("should support database selection", () => {
      expect(() =>
        createRedisPubSubOutput({
          host: "localhost",
          port: 6379,
          channel: "events",
          db: 2,
        }),
      ).not.toThrow();
    });

    it("should support retry configuration", () => {
      expect(() =>
        createRedisPubSubOutput({
          host: "localhost",
          port: 6379,
          channel: "events",
          maxRetries: 5,
        }),
      ).not.toThrow();
    });

    it("should support connection pooling options", () => {
      expect(() =>
        createRedisPubSubOutput({
          host: "localhost",
          port: 6379,
          channel: "events",
          connectTimeout: 5000,
          commandTimeout: 3000,
          keepAlive: 15000,
          lazyConnect: true,
        }),
      ).not.toThrow();
    });
  });

  describe("Validation", () => {
    it("should fail with empty channel name", () => {
      expect(() =>
        createRedisPubSubOutput({
          host: "localhost",
          port: 6379,
          channel: "",
        }),
      ).toThrow();
    });

    it("should fail with invalid hostname", () => {
      expect(() =>
        createRedisPubSubOutput({
          host: "",
          port: 6379,
          channel: "events",
        }),
      ).toThrow();
    });

    it("should fail with invalid port", () => {
      expect(() =>
        createRedisPubSubOutput({
          host: "localhost",
          port: 99999,
          channel: "events",
        }),
      ).toThrow();
    });

    it("should fail with negative database number", () => {
      expect(() =>
        createRedisPubSubOutput({
          host: "localhost",
          port: 6379,
          channel: "events",
          db: -1,
        }),
      ).toThrow();
    });
  });

  describe("connection logging", () => {
    const connectionMessage =
      "Connected to Redis Pub/Sub: redis://localhost:6379/0";

    const captureLogs = <A, E>(effect: Effect.Effect<A, E>) => {
      const messages: unknown[] = [];
      const logger = Logger.make<unknown, void>(({ message }) => {
        messages.push(message);
      });
      return Effect.runPromise(
        effect.pipe(
          Effect.provideService(References.MinimumLogLevel, "Info"),
          Effect.provide(Logger.layer([logger])),
        ),
      ).then(() => messages);
    };

    const connectionEvents = (messages: unknown[]) =>
      messages.filter((message) => {
        if (typeof message === "string") {
          return message === connectionMessage;
        }
        if (Array.isArray(message)) {
          return message.some((part) => part === connectionMessage);
        }
        return false;
      });

    it("emits zero connection events until the first send", async () => {
      const messages = await captureLogs(
        Effect.sync(() => {
          createRedisPubSubOutput({
            host: "localhost",
            port: 6379,
            channel: "events",
          });
        }),
      );
      expect(connectionEvents(messages)).toHaveLength(0);
    });

    it("emits exactly one connection event across sequential sends", async () => {
      const output = createRedisPubSubOutput({
        host: "localhost",
        port: 6379,
        channel: "events",
      });

      const messages = await captureLogs(
        Effect.gen(function* () {
          yield* output.send(createMessage("A"));
          yield* output.send(createMessage("B"));
          yield* output.send(createMessage("C"));
        }),
      );

      expect(connectionEvents(messages)).toHaveLength(1);
      expect(vi.mocked(Redis)).toHaveBeenCalled();

      if (output.close) {
        await Effect.runPromise(output.close());
      }
    });

    it("emits exactly one connection event for concurrent first sends", async () => {
      const output = createRedisPubSubOutput({
        host: "localhost",
        port: 6379,
        channel: "events",
      });

      const messages = await captureLogs(
        Effect.all(
          [
            output.send(createMessage("A")),
            output.send(createMessage("B")),
            output.send(createMessage("C")),
          ],
          { concurrency: "unbounded" },
        ),
      );

      expect(connectionEvents(messages)).toHaveLength(1);

      if (output.close) {
        await Effect.runPromise(output.close());
      }
    });

    it("emits one connection event per separately constructed instance", async () => {
      const first = createRedisPubSubOutput({
        host: "localhost",
        port: 6379,
        channel: "events-a",
      });
      const second = createRedisPubSubOutput({
        host: "localhost",
        port: 6379,
        channel: "events-b",
      });

      const messages = await captureLogs(
        Effect.gen(function* () {
          yield* first.send(createMessage("A"));
          yield* second.send(createMessage("B"));
        }),
      );

      expect(connectionEvents(messages)).toHaveLength(2);

      if (first.close) {
        await Effect.runPromise(first.close());
      }
      if (second.close) {
        await Effect.runPromise(second.close());
      }
    });
  });
});
