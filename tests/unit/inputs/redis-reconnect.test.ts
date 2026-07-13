import { describe, expect, it } from "vitest";
import { Effect, Either } from "effect";
import * as Schema from "effect/Schema";
import {
  reconnectDelayMs,
  withReconnect,
} from "../../../src/inputs/redis-reconnect.js";
import { RedisListInputError } from "../../../src/inputs/redis-list-input.js";
import { PipelineConfigSchema } from "../../../src/core/config-loader.js";

describe("Redis reconnect policy", () => {
  it("uses capped exponential backoff", () => {
    expect(
      [1, 2, 3, 4, 10].map((attempt) => reconnectDelayMs(attempt, 100)),
    ).toEqual([100, 200, 400, 800, 30_000]);
  });

  it("preserves the typed error after reconnect exhaustion", async () => {
    let attempts = 0;
    const error = new RedisListInputError("Redis unavailable", "intermittent");
    const operation = Effect.suspend(() => {
      attempts += 1;
      return Effect.fail(error);
    });

    const result = await Effect.runPromise(
      Effect.either(
        withReconnect(operation, {
          maxReconnectAttempts: 2,
          reconnectBackoffMs: 1,
        }),
      ),
    );

    expect(attempts).toBe(3);
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) expect(result.left).toBe(error);
  });

  it.each([
    {
      redis_list: {
        host: "localhost",
        port: 6379,
        key: "tasks",
        max_reconnect_attempts: 4,
        reconnect_backoff_ms: 250,
      },
    },
    {
      redis_streams: {
        url: "redis://localhost:6379",
        stream: "events",
        max_reconnect_attempts: 4,
        reconnect_backoff_ms: 250,
      },
    },
  ])("accepts reconnect configuration", async (input) => {
    const result = await Effect.runPromise(
      Effect.either(
        Schema.decodeUnknown(PipelineConfigSchema)({
          input,
          output: { capture: {} },
        }),
      ),
    );
    expect(Either.isRight(result)).toBe(true);
  });

  it("rejects invalid reconnect configuration", async () => {
    const result = await Effect.runPromise(
      Effect.either(
        Schema.decodeUnknown(PipelineConfigSchema)({
          input: {
            redis_list: {
              host: "localhost",
              port: 6379,
              key: "tasks",
              max_reconnect_attempts: -1,
              reconnect_backoff_ms: 0,
            },
          },
          output: { capture: {} },
        }),
      ),
    );
    expect(Either.isLeft(result)).toBe(true);
  });
});
