import { describe, expect, it } from "vitest";
import { Effect, Fiber, Option, Queue } from "effect";
import {
  createInputQueue,
  offerInputQueue,
  recordQueueDrop,
} from "../../../src/inputs/input-queue.js";
import { MetricsAccumulator } from "../../../src/core/metrics.js";

describe("bounded input queue policies", () => {
  it("blocks the producer until bounded capacity is available", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const queue = yield* createInputQueue<number>(1, "block");
        yield* offerInputQueue(queue, 1, "block", 1);
        const producer = yield* Effect.fork(
          offerInputQueue(queue, 2, "block", 1),
        );
        yield* Effect.sleep("10 millis");
        const beforeTake = yield* Fiber.poll(producer);
        const first = yield* Queue.take(queue);
        const offer = yield* Fiber.join(producer);
        const second = yield* Queue.take(queue);
        return { beforeTake, first, offer, second };
      }),
    );

    expect(Option.isNone(result.beforeTake)).toBe(true);
    expect(result.first).toBe(1);
    expect(result.offer).toEqual({ accepted: true, dropped: 0 });
    expect(result.second).toBe(2);
  });

  it("drop_new keeps the oldest queued values", async () => {
    const values = await Effect.runPromise(
      Effect.gen(function* () {
        const queue = yield* createInputQueue<number>(2, "drop_new");
        yield* offerInputQueue(queue, 1, "drop_new", 2);
        yield* offerInputQueue(queue, 2, "drop_new", 2);
        const overflow = yield* offerInputQueue(queue, 3, "drop_new", 2);
        return {
          overflow,
          values: [yield* Queue.take(queue), yield* Queue.take(queue)],
        };
      }),
    );

    expect(values.overflow).toEqual({ accepted: false, dropped: 1 });
    expect(values.values).toEqual([1, 2]);
  });

  it("drop_old evicts the oldest queued value", async () => {
    const values = await Effect.runPromise(
      Effect.gen(function* () {
        const queue = yield* createInputQueue<number>(2, "drop_old");
        yield* offerInputQueue(queue, 1, "drop_old", 2);
        yield* offerInputQueue(queue, 2, "drop_old", 2);
        const overflow = yield* offerInputQueue(queue, 3, "drop_old", 2);
        return {
          overflow,
          values: [yield* Queue.take(queue), yield* Queue.take(queue)],
        };
      }),
    );

    expect(values.overflow).toEqual({ accepted: true, dropped: 1 });
    expect(values.values).toEqual([2, 3]);
  });

  it("counts every configured-policy drop in input metrics", async () => {
    const metrics = new MetricsAccumulator("queue-test");
    const state = { lastLogAt: 0, suppressed: 0 };
    await Effect.runPromise(recordQueueDrop(metrics, state, "Test"));
    await Effect.runPromise(recordQueueDrop(metrics, state, "Test"));
    expect(metrics.getInputMetrics().messagesDropped).toBe(2);
  });

  it("keeps accepted and dropped message metrics disjoint", async () => {
    const metrics = new MetricsAccumulator("queue-metrics-test");
    const state = { lastLogAt: 0, suppressed: 0 };

    await Effect.runPromise(
      Effect.gen(function* () {
        const queue = yield* createInputQueue<number>(1, "drop_new");
        for (const value of [1, 2]) {
          const offer = yield* offerInputQueue(queue, value, "drop_new", 1);
          if (offer.accepted) metrics.recordProcessed();
          if (offer.dropped > 0) {
            yield* recordQueueDrop(metrics, state, "Test");
          }
        }
      }),
    );

    const snapshot = metrics.getInputMetrics();
    expect(snapshot.messagesProcessed).toBe(1);
    expect(snapshot.messagesDropped).toBe(1);
    expect(snapshot.messagesProcessed + snapshot.messagesDropped).toBe(2);
  });
});
