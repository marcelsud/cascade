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

  it("does not retry a fatal failure when the reconnect limit is omitted", async () => {
    let attempts = 0;
    const fatal = new RedisListInputError(
      "NOAUTH Authentication required.",
      "fatal",
    );
    const operation = Effect.suspend(() => {
      attempts += 1;
      if (attempts === 1) {
        return Effect.fail(fatal);
      }
      return Effect.succeed("unexpected recovery");
    });

    const result = await Effect.runPromise(
      Effect.either(
        withReconnect(operation, {
          reconnectBackoffMs: 1,
        }),
      ),
    );

    expect(attempts).toBe(1);
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) expect(result.left).toBe(fatal);
  });

  it("does not retry a logical failure when the reconnect limit is omitted", async () => {
    let attempts = 0;
    let retries = 0;
    const logical = new RedisListInputError(
      "Schema validation failed",
      "logical",
    );
    const operation = Effect.suspend(() => {
      attempts += 1;
      if (attempts === 1) {
        return Effect.fail(logical);
      }
      return Effect.succeed("unexpected recovery");
    });

    const result = await Effect.runPromise(
      Effect.either(
        withReconnect(
          operation,
          {
            reconnectBackoffMs: 1,
          },
          () =>
            Effect.sync(() => {
              retries += 1;
            }),
        ),
      ),
    );

    expect(attempts).toBe(1);
    expect(retries).toBe(0);
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) expect(result.left).toBe(logical);
  });

  it("does not invoke onRetry or backoff for a fatal failure with a positive limit", async () => {
    let attempts = 0;
    let retries = 0;
    const fatal = new RedisListInputError(
      "NOAUTH Authentication required.",
      "fatal",
    );
    const operation = Effect.suspend(() => {
      attempts += 1;
      return Effect.fail(fatal);
    });

    const result = await Effect.runPromise(
      Effect.either(
        withReconnect(
          operation,
          {
            maxReconnectAttempts: 5,
            reconnectBackoffMs: 1,
          },
          () =>
            Effect.sync(() => {
              retries += 1;
            }),
        ),
      ),
    );

    expect(attempts).toBe(1);
    expect(retries).toBe(0);
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) expect(result.left).toBe(fatal);
  });

  it("retries an intermittent failure until success when the limit is omitted", async () => {
    let attempts = 0;
    let retries = 0;
    const intermittent = new RedisListInputError(
      "Redis unavailable",
      "intermittent",
    );
    const operation = Effect.suspend(() => {
      attempts += 1;
      if (attempts === 1) {
        return Effect.fail(intermittent);
      }
      return Effect.succeed("recovered");
    });

    const result = await Effect.runPromise(
      Effect.either(
        withReconnect(
          operation,
          {
            reconnectBackoffMs: 1,
          },
          () =>
            Effect.sync(() => {
              retries += 1;
            }),
        ),
      ),
    );

    expect(attempts).toBe(2);
    expect(retries).toBe(1);
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) expect(result.right).toBe("recovered");
  });

  it.each([
    {
      redis_list: {
        url: "redis://localhost:6379",
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
              url: "redis://localhost:6379",
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
