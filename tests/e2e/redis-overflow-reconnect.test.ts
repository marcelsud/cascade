import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { create } from "../../src/core/pipeline.js";
import type { Output } from "../../src/core/types.js";
import { createRedisListInput } from "../../src/inputs/redis-list-input.js";
import { createRedisPubSubInput } from "../../src/inputs/redis-pubsub-input.js";
import {
  createCaptureOutput,
  type CaptureOutput,
} from "../../src/testing/capture-output.js";
import {
  E2EResources,
  type RunningPipeline,
  runPipeline,
  startPipeline,
  uniqueResourceName,
  waitFor,
} from "./helpers/index.js";

describe("Redis overflow and reconnect behavior", () => {
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

  it("drop_old retains recent pub/sub messages and records drops", async () => {
    const channel = uniqueResourceName("drop-old");
    await resources.redis.connect();
    const input = createRedisPubSubInput({
      host: "127.0.0.1",
      port: 6379,
      channels: [channel],
      queueSize: 3,
      overflow: "drop_old",
    });
    const capture: CaptureOutput = await Effect.runPromise(createCaptureOutput());
    const slowOutput: Output = {
      name: "slow-capture-output",
      send: (message) =>
        Effect.sleep("100 millis").pipe(
          Effect.zipRight(capture.send(message)),
        ),
      close: capture.close,
      getMetrics: capture.getMetrics,
    };
    const running = await startPipeline(
      create({
        name: "redis-pubsub-drop-old",
        input,
        processors: [],
        output: slowOutput,
        backpressure: { maxConcurrentMessages: 1 },
      }),
    );
    activeRun = running;
    await waitFor(
      async () =>
        ((await resources.redis.pubsub("channels", channel)) as string[]).includes(
          channel,
        ),
      "Redis pub/sub subscription",
    );

    for (let index = 0; index < 20; index++) {
      await resources.redis.publish(channel, JSON.stringify({ index }));
    }
    await waitFor(
      async () =>
        (await Effect.runPromise(capture.getMessages())).some(
          (message) => message.content.index === 19,
        ),
      "newest published message to reach the sink",
    );
    await Effect.runPromise(running.shutdown.request);
    const result = await running.result;
    activeRun = undefined;

    const delivered = await Effect.runPromise(capture.getMessages());
    expect(result.shutdown).toBe("graceful");
    expect(result.metrics?.input?.messagesDropped).toBeGreaterThan(0);
    expect(delivered.some((message) => message.content.index === 19)).toBe(true);
    expect(delivered.length).toBeLessThan(20);
  }, 20_000);

  it("exhausts Redis-list reconnects with a typed terminal error", async () => {
    const startedAt = Date.now();
    const result = await runPipeline(
      create({
        name: "redis-list-reconnect-exhaustion",
        input: createRedisListInput({
          host: "127.0.0.1",
          port: 1,
          key: "unreachable",
          lazyConnect: true,
          enableOfflineQueue: false,
          maxRetriesPerRequest: 0,
          connectTimeout: 50,
          maxReconnectAttempts: 2,
          reconnectBackoffMs: 50,
        }),
        processors: [],
        output: await Effect.runPromise(createCaptureOutput()),
      }),
    );
    const elapsed = Date.now() - startedAt;

    expect(result.success).toBe(false);
    expect(
      result.errors?.some(
        (error) =>
          typeof error === "object" &&
          error !== null &&
          "_tag" in error &&
          error._tag === "RedisListInputError",
      ),
    ).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(125);
    expect(elapsed).toBeLessThan(2_000);
  }, 10_000);
});
