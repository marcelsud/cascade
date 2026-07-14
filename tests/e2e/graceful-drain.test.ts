import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { create } from "../../src/core/pipeline.js";
import type { Output } from "../../src/core/types.js";
import { createRedisListInput } from "../../src/inputs/redis-list-input.js";
import {
  createCaptureOutput,
  type CaptureOutput,
} from "../../src/testing/capture-output.js";
import {
  E2EResources,
  type RunningPipeline,
  startPipeline,
  waitFor,
} from "./helpers/index.js";

describe("graceful drain", () => {
  let resources: E2EResources;
  let activeRun: RunningPipeline | undefined;

  beforeEach(() => {
    resources = new E2EResources();
  });

  afterEach(async () => {
    if (activeRun) {
      await Effect.runPromise(activeRun.shutdown.requestForce);
      await activeRun.result;
    }
    await resources.cleanup();
  });

  const inputFor = (key: string) =>
    createRedisListInput({
      host: "127.0.0.1",
      port: 6379,
      key,
      timeout: 1,
      maxReconnectAttempts: 0,
    });

  const runUntilCaptured = async (
    key: string,
    output: CaptureOutput,
    expected: number,
    delayMs = 0,
  ) => {
    const sink: Output = {
      name: "slow-capture-output",
      send: (message) =>
        Effect.sleep(`${delayMs} millis`).pipe(
          Effect.zipRight(output.send(message)),
        ),
      close: output.close,
      getMetrics: output.getMetrics,
    };
    const running = await startPipeline(
      create({
        name: "redis-list-graceful-drain",
        input: inputFor(key),
        processors: [],
        output: sink,
        backpressure: { maxConcurrentMessages: 2 },
      }),
    );
    activeRun = running;
    await waitFor(
      async () => (await Effect.runPromise(output.getCount())) >= expected,
      `${expected} captured Redis list messages`,
    );
    await Effect.runPromise(running.shutdown.request);
    const result = await running.result;
    activeRun = undefined;
    return result;
  };

  it("finishes admitted work and leaves untouched list items for the next run", async () => {
    const count = 20;
    const key = await resources.redisKey("graceful-drain");
    const ids = Array.from({ length: count }, (_, index) => `item-${index}`);
    await resources.redis.rpush(
      key,
      ...ids.map((id) => JSON.stringify({ id })),
    );

    const firstCapture = await Effect.runPromise(createCaptureOutput());
    const firstResult = await runUntilCaptured(key, firstCapture, 1, 75);
    const firstMessages = await Effect.runPromise(firstCapture.getMessages());
    const remaining = await resources.redis.llen(key);

    expect(firstResult.shutdown).toBe("graceful");
    expect(firstMessages.length + remaining).toBe(count);

    const secondCapture = await Effect.runPromise(createCaptureOutput());
    const secondResult = await runUntilCaptured(
      key,
      secondCapture,
      remaining,
    );
    const secondMessages = await Effect.runPromise(secondCapture.getMessages());
    const delivered = [...firstMessages, ...secondMessages].map(
      (message) => message.content.id,
    );

    expect(secondResult.shutdown).toBe("graceful");
    expect(delivered).toHaveLength(count);
    expect(new Set(delivered)).toEqual(new Set(ids));
    expect(await resources.redis.llen(key)).toBe(0);
  }, 20_000);
});
