import { describe, it, expect, vi, beforeEach } from "vitest";
import { Effect, Logger, LogLevel } from "effect";
import Redis from "ioredis";
import { createRedisStreamsOutput } from "../../../src/outputs/redis-streams-output.js";
import type { Message } from "../../../src/core/types.js";

vi.mock("ioredis", () => {
  return {
    default: vi.fn(() => ({
      status: "ready",
      xadd: vi.fn().mockResolvedValue("1-0"),
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

describe("RedisStreamsOutput", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("connection logging", () => {
    const connectionMessage =
      "Connected to Redis stream: redis://localhost:6379/0";

    const captureLogs = <A, E>(effect: Effect.Effect<A, E>) => {
      const messages: unknown[] = [];
      const logger = Logger.make<unknown, void>(({ message }) => {
        messages.push(message);
      });
      return Effect.runPromise(
        effect.pipe(
          Logger.withMinimumLogLevel(LogLevel.Info),
          Effect.provide(Logger.replace(Logger.defaultLogger, logger)),
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
          createRedisStreamsOutput({
            host: "localhost",
            port: 6379,
            stream: "events",
          });
        }),
      );
      expect(connectionEvents(messages)).toHaveLength(0);
    });

    it("emits exactly one connection event across sequential sends", async () => {
      const output = createRedisStreamsOutput({
        host: "localhost",
        port: 6379,
        stream: "events",
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
      const output = createRedisStreamsOutput({
        host: "localhost",
        port: 6379,
        stream: "events",
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
      const first = createRedisStreamsOutput({
        host: "localhost",
        port: 6379,
        stream: "events-a",
      });
      const second = createRedisStreamsOutput({
        host: "localhost",
        port: 6379,
        stream: "events-b",
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
