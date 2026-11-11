import { Effect, Stream } from "effect";
import type Redis from "ioredis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { create, run } from "../../src/core/pipeline.js";
import type { Output } from "../../src/core/types.js";
import { createRedisStreamsInput } from "../../src/inputs/redis-streams-input.js";
import { createCaptureOutput } from "../../src/testing/capture-output.js";
import {
  E2EResources,
  REDIS_URL,
  requireE2EInfrastructure,
  runPipeline,
  uniqueResourceName,
} from "./helpers/index.js";

requireE2EInfrastructure();

const pendingCount = async (
  redis: Redis,
  stream: string,
  group: string,
): Promise<number> => {
  const summary = (await redis.xpending(stream, group)) as
    | [number, string | null, string | null, unknown]
    | null;
  return summary?.[0] ?? 0;
};

const redisEndpoint = new URL(REDIS_URL);
const redisHost = redisEndpoint.hostname || "127.0.0.1";
const redisPort = Number(redisEndpoint.port || "6379");
const redisPassword = (() => {
  if (!redisEndpoint.password) return undefined;
  try {
    return decodeURIComponent(redisEndpoint.password);
  } catch {
    return redisEndpoint.password;
  }
})();
const redisDb = (() => {
  const path = redisEndpoint.pathname.replace(/^\/+/, "");
  if (!path) return undefined;
  const db = Number(path.split("/")[0]);
  return Number.isInteger(db) && db >= 0 ? db : undefined;
})();

describe("Redis Streams consumer-group acknowledgement", () => {
  let resources: E2EResources;

  beforeEach(() => {
    resources = new E2EResources();
  });

  afterEach(async () => {
    await resources.cleanup();
  });

  const seedStream = async (label: string) => {
    const stream = await resources.redisKey(label);
    const group = uniqueResourceName(`${label}-group`);
    const entryId = await resources.redis.xadd(
      stream,
      "*",
      "content",
      JSON.stringify({ id: label }),
      "metadata",
      JSON.stringify({ source: "e2e" }),
      "timestamp",
      String(Date.now()),
    );
    if (!entryId) {
      throw new Error(`XADD failed for stream ${stream}`);
    }
    return { stream, group, entryId };
  };

  const inputFor = (
    stream: string,
    group: string,
    consumerName = uniqueResourceName("consumer"),
  ) => {
    const input = createRedisStreamsInput({
      host: redisHost,
      port: redisPort,
      ...(redisPassword !== undefined ? { password: redisPassword } : {}),
      ...(redisDb !== undefined ? { db: redisDb } : {}),
      stream,
      mode: "consumer-group",
      consumerGroup: group,
      consumerName,
      startId: "0",
      blockMs: 1000,
      count: 1,
      maxReconnectAttempts: 0,
    });
    return {
      ...input,
      stream: input.stream.pipe(Stream.take(1)),
    };
  };

  it("clears XPENDING after successful pipeline delivery", async () => {
    const { stream, group } = await seedStream("streams-ack-success");
    const capture = await Effect.runPromise(createCaptureOutput());

    const result = await runPipeline(
      create({
        name: "redis-streams-ack-success",
        input: inputFor(stream, group),
        processors: [],
        output: capture,
      }),
    );

    const messages = await Effect.runPromise(capture.getMessages());
    expect(result.success).toBe(true);
    expect(messages).toHaveLength(1);
    expect(await pendingCount(resources.redis, stream, group)).toBe(0);
  }, 20_000);

  it("leaves the entry pending when downstream output fails", async () => {
    const { stream, group } = await seedStream("streams-ack-failure");
    const failing: Output = {
      name: "failing-output",
      send: () => Effect.fail(new Error("downstream failed")),
    };

    const result = await runPipeline(
      create({
        name: "redis-streams-ack-failure",
        input: inputFor(stream, group),
        processors: [],
        output: failing,
      }),
    );

    expect(result.success).toBe(false);
    expect(result.stats.failed).toBeGreaterThanOrEqual(1);
    expect(await pendingCount(resources.redis, stream, group)).toBe(1);
  }, 20_000);

  it("replays a failed entry for the same consumer before reading fresh entries", async () => {
    const { stream, group, entryId } = await seedStream(
      "streams-pending-restart",
    );
    const consumer = uniqueResourceName("stable-consumer");
    const failedDelivery = () =>
      Effect.runPromise(
        run(
          create({
            name: "pending-failed-delivery",
            input: inputFor(stream, group, consumer),
            processors: [],
            output: {
              name: "failed-output",
              send: () => Effect.fail(new Error("downstream failed")),
            },
          }),
        ).pipe(Effect.timeout("3 seconds")),
      );
    const first = await failedDelivery();
    expect(first.stats.failed).toBe(1);
    expect(await pendingCount(resources.redis, stream, group)).toBe(1);

    const freshId = await resources.redis.xadd(
      stream,
      "*",
      "content",
      JSON.stringify({ id: "fresh-entry" }),
    );
    expect(freshId).not.toBeNull();
    const second = await failedDelivery();
    expect(second.stats.failed).toBe(1);
    expect(await pendingCount(resources.redis, stream, group)).toBe(1);

    const recovered = await Effect.runPromise(createCaptureOutput());
    const result = await Effect.runPromise(
      run(
        create({
          name: "pending-successful-replay",
          input: inputFor(stream, group, consumer),
          processors: [],
          output: recovered,
        }),
      ).pipe(Effect.timeout("3 seconds")),
    );
    expect(result.success).toBe(true);
    expect(
      (await Effect.runPromise(recovered.getMessages())).map(
        (message) => message.metadata.externalId,
      ),
    ).toEqual([entryId]);
    expect(await pendingCount(resources.redis, stream, group)).toBe(0);

    const fresh = await Effect.runPromise(createCaptureOutput());
    const freshResult = await Effect.runPromise(
      run(
        create({
          name: "pending-followed-by-new-entry",
          input: inputFor(stream, group, consumer),
          processors: [],
          output: fresh,
        }),
      ).pipe(Effect.timeout("3 seconds")),
    );
    expect(freshResult.success).toBe(true);
    expect(
      (await Effect.runPromise(fresh.getMessages())).map(
        (message) => message.metadata.externalId,
      ),
    ).toEqual([freshId]);
    expect(await pendingCount(resources.redis, stream, group)).toBe(0);
  }, 20_000);
});
