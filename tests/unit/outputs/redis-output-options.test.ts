import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect, Either, Fiber, TestClock } from "effect";
import * as TestContext from "effect/TestContext";
import * as Schema from "effect/Schema";
import {
  closeRedisOutput,
  interpolateMessageTemplate,
  openRedisOutputClient,
  recordRedisSendSuccess,
  redisConnectionSchemaFields,
  runRedisSendWithRetry,
  serializeRedisMessagePayload,
} from "../../../src/outputs/redis-output-options.js";
import { MetricsAccumulator } from "../../../src/core/metrics.js";
import type { Message } from "../../../src/core/types.js";

interface MockRedisInstance {
  options: Record<string, unknown>;
  status: string;
  on: ReturnType<typeof vi.fn>;
  quit: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

vi.mock("ioredis", () => {
  return {
    default: vi.fn(function MockRedis(
      this: MockRedisInstance,
      options: Record<string, unknown>,
    ) {
      this.options = options;
      this.status = "ready";
      this.on = vi.fn();
      this.quit = vi.fn(async () => "OK");
      this.disconnect = vi.fn();
      return this;
    }),
  };
});

import Redis from "ioredis";

const message = (overrides: Partial<Message> = {}): Message => ({
  id: "id-1",
  content: { type: "order", count: 2, name: "alice" },
  metadata: { userId: "u-9" },
  timestamp: 123,
  correlationId: "c-1",
  ...overrides,
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("redis-output-options helpers", () => {
  describe("redisConnectionSchemaFields", () => {
    it("decodes maxRetries and shared client knobs", () => {
      const schema = Schema.Struct({ ...redisConnectionSchemaFields });
      const decoded = Effect.runSync(
        Schema.decodeUnknown(schema)({
          maxRetries: 2,
          connectTimeout: 1500,
          lazyConnect: true,
        }),
      );
      expect(decoded).toEqual({
        maxRetries: 2,
        connectTimeout: 1500,
        lazyConnect: true,
      });
    });

    it("rejects invalid maxRetries", () => {
      const schema = Schema.Struct({ ...redisConnectionSchemaFields });
      const result = Effect.runSync(
        Effect.either(Schema.decodeUnknown(schema)({ maxRetries: 99 })),
      );
      expect(Either.isLeft(result)).toBe(true);
    });
  });

  describe("interpolateMessageTemplate", () => {
    it("resolves nested content and metadata paths", () => {
      expect(
        interpolateMessageTemplate(
          "events:{{content.type}}:{{metadata.userId}}",
          message(),
        ),
      ).toBe("events:order:u-9");
    });

    it("returns empty string for missing or null paths", () => {
      expect(
        interpolateMessageTemplate(
          "x:{{content.missing.nested}}:{{metadata.none}}",
          message({ content: { type: "a" }, metadata: {} }),
        ),
      ).toBe("x::");
    });

    it("stringifies non-string leaves", () => {
      expect(interpolateMessageTemplate("n:{{content.count}}", message())).toBe(
        "n:2",
      );
    });

    it("resolves property access through primitive intermediate values", () => {
      expect(
        interpolateMessageTemplate("len:{{content.name.length}}", message()),
      ).toBe("len:5");
    });
  });

  describe("serializeRedisMessagePayload", () => {
    it("serializes the full message envelope", () => {
      const msg = message({
        trace: { traceId: "t", spanId: "s" },
      });
      expect(JSON.parse(serializeRedisMessagePayload(msg))).toEqual({
        id: "id-1",
        correlationId: "c-1",
        timestamp: 123,
        content: { type: "order", count: 2, name: "alice" },
        metadata: { userId: "u-9" },
        trace: { traceId: "t", spanId: "s" },
      });
    });
  });

  describe("openRedisOutputClient", () => {
    it("creates a client and attaches the error observer", () => {
      const client = openRedisOutputClient(
        { host: "localhost", port: 6379, lazyConnect: true },
        "unit redis output",
      ) as unknown as MockRedisInstance;

      expect(Redis).toHaveBeenCalled();
      expect(client.on).toHaveBeenCalledWith("error", expect.any(Function));
      expect(client.options).toMatchObject({
        host: "localhost",
        port: 6379,
        lazyConnect: true,
      });
    });
  });

  describe("runRedisSendWithRetry", () => {
    it("retries with exponential backoff then records one final error metric/log", async () => {
      const metrics = new MetricsAccumulator("retry-output");
      let attempts = 0;
      const operation = Effect.suspend(() => {
        attempts += 1;
        return Effect.fail({ message: `boom-${attempts}` });
      });

      const result = await Effect.runPromise(
        Effect.either(
          Effect.gen(function* () {
            const fiber = yield* Effect.fork(
              runRedisSendWithRetry(
                operation,
                metrics,
                2,
                "Redis push failed: ",
              ),
            );
            // times=2 => 3 attempts total with 1s then 2s exponential gaps.
            yield* TestClock.adjust("1 second");
            yield* TestClock.adjust("2 seconds");
            return yield* Fiber.join(fiber);
          }).pipe(Effect.provide(TestContext.TestContext)),
        ),
      );

      expect(attempts).toBe(3);
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        const error = result.left;
        expect(
          error && typeof error === "object" && "message" in error
            ? String(error.message)
            : "",
        ).toBe("boom-3");
      }
      expect(metrics.getOutputMetrics().sendErrors).toBe(1);
    });

    it("returns the successful value with measured duration", async () => {
      const metrics = new MetricsAccumulator("ok-output");
      const [value, duration] = await Effect.runPromise(
        runRedisSendWithRetry(
          Effect.succeed("ok"),
          metrics,
          1,
          "should-not-log: ",
        ),
      );
      expect(value).toBe("ok");
      expect(duration).toBeGreaterThanOrEqual(0);
      expect(metrics.getOutputMetrics().sendErrors).toBe(0);
    });
  });

  describe("recordRedisSendSuccess", () => {
    it("records a send and resets the counter after 100 messages", async () => {
      const metrics = new MetricsAccumulator("test-output");
      const emitSpy = vi.spyOn(metrics, "getOutputMetrics");

      let count = 99;
      count = await Effect.runPromise(
        recordRedisSendSuccess(metrics, 5, count),
      );
      expect(count).toBe(0);
      expect(metrics.getOutputMetrics().messagesSent).toBe(1);
      expect(emitSpy).toHaveBeenCalled();
    });
  });

  describe("closeRedisOutput", () => {
    it("flushes remaining metrics before closing a ready client", async () => {
      const metrics = new MetricsAccumulator("close-output");
      metrics.recordSent(1, 1);
      const client = {
        status: "ready",
        quit: vi.fn(async () => "OK"),
        disconnect: vi.fn(),
      };
      const order: string[] = [];
      const getSpy = vi
        .spyOn(metrics, "getOutputMetrics")
        .mockImplementation(() => {
          order.push("metrics");
          return {
            component: "close-output",
            timestamp: 1,
            messagesSent: 1,
            batchesSent: 0,
            sendErrors: 0,
            averageDuration: 1,
            totalDuration: 1,
          };
        });
      client.quit.mockImplementation(async () => {
        order.push("quit");
        return "OK";
      });

      await Effect.runPromise(closeRedisOutput(client as never, metrics, 1));

      expect(order).toEqual(["metrics", "quit"]);
      expect(client.quit).toHaveBeenCalledOnce();
      expect(client.disconnect).not.toHaveBeenCalled();
      getSpy.mockRestore();
    });

    it("swallows close failures as best-effort cleanup", async () => {
      const metrics = new MetricsAccumulator("close-fail");
      const errorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      const client = {
        status: "ready",
        quit: vi.fn(async () => {
          throw new Error("quit failed");
        }),
        disconnect: vi.fn(),
      };

      await expect(
        Effect.runPromise(closeRedisOutput(client as never, metrics, 0)),
      ).resolves.toBeUndefined();

      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockRestore();
    });
  });
});
