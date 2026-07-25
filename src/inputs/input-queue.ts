import { Duration, Effect, Queue } from "effect";
import type { MetricsAccumulator } from "../core/metrics.js";

export type OverflowPolicy = "block" | "drop_new" | "drop_old";

export interface QueueOfferResult {
  readonly accepted: boolean;
  readonly dropped: number;
}

export const createInputQueue = <A>(
  capacity: number,
  overflow: OverflowPolicy,
): Effect.Effect<Queue.Queue<A>> => {
  switch (overflow) {
    case "drop_new":
      return Queue.dropping<A>(capacity);
    case "drop_old":
      return Queue.sliding<A>(capacity);
    case "block":
      return Queue.bounded<A>(capacity);
  }
};

/** Offer one value and report whether either end of the queue was dropped. */
export const offerInputQueue = <A>(
  queue: Queue.Queue<A>,
  value: A,
  overflow: OverflowPolicy,
  capacity: number,
): Effect.Effect<QueueOfferResult> =>
  Effect.gen(function* () {
    // Queue.size and Queue.offer are separate operations. With concurrent
    // drop_old producers this makes the drop count observational/approximate,
    // while the sliding queue's actual eviction behavior remains atomic.
    const wasFull =
      overflow === "drop_old" && (yield* Queue.size(queue)) >= capacity;
    const accepted = yield* Queue.offer(queue, value);
    return {
      accepted,
      dropped: !accepted || wasFull ? 1 : 0,
    };
  });

export interface DropLogState {
  lastLogAt: number;
  suppressed: number;
}

/** Count every drop and rate-limit warnings to one per five seconds. */
export const recordQueueDrop = (
  metrics: MetricsAccumulator,
  state: DropLogState,
  component: string,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    metrics.recordDropped();
    const now = Date.now();
    if (state.lastLogAt === 0 || now - state.lastLogAt >= 5_000) {
      const suffix =
        state.suppressed > 0
          ? ` (${state.suppressed} additional drops suppressed)`
          : "";
      yield* Effect.logWarning(`${component} input queue overflow${suffix}`);
      state.lastLogAt = now;
      state.suppressed = 0;
    } else {
      state.suppressed += 1;
    }
  });

/** Poll interval while waiting for consumers to drain a one-shot input queue. */
const DRAIN_POLL_INTERVAL_MS = 5;

/**
 * Wait until consumers have taken every queued value.
 *
 * A resolved `Queue.offer` only means the queue accepted the value; the stream
 * may not have taken it yet. Shutting down at that point discards the
 * remainder and `Stream.fromQueue` reports it as a normal end of stream, so the
 * loss is silent. Callers shut the queue down after this resolves.
 *
 * `isAborted` lets an explicit close cut the wait short. A concurrent shutdown
 * makes `Queue.size` interrupt; that is treated as "nothing left to drain".
 */
export const awaitInputQueueDrain = <A>(
  queue: Queue.Queue<A>,
  isAborted: () => boolean,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    while (!isAborted()) {
      const remaining = yield* Queue.size(queue).pipe(
        Effect.catchAllCause(() => Effect.succeed(0)),
      );
      if (remaining <= 0) return;
      yield* Effect.sleep(Duration.millis(DRAIN_POLL_INTERVAL_MS));
    }
  });
