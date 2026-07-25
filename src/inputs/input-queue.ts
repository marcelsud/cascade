import { Cause, Chunk, Effect, Option, Queue, Stream } from "effect";
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

/**
 * Stream a bounded input queue, ending only once the producer is done AND the
 * queue is exhausted.
 *
 * `Stream.fromQueue` ends the moment the queue is shut down and discards
 * whatever the consumer has not taken yet — and it reports that as a normal
 * end of stream, so the loss is silent. A producer therefore cannot signal
 * completion by shutting the queue down. Instead it flips `isProducerDone`
 * once every offer has resolved; this stream drains what is left and then
 * ends. An explicit `Queue.shutdown` (from `close()`) still ends it at once.
 */
export const streamInputQueue = <A>(
  queue: Queue.Queue<A>,
  isProducerDone: () => boolean,
): Stream.Stream<A> =>
  Stream.repeatEffectChunkOption(
    Effect.suspend(() =>
      isProducerDone()
        ? Queue.takeAll(queue)
        : Queue.takeBetween(queue, 1, Queue.capacity(queue)),
    ).pipe(
      Effect.catchAllCause((cause) =>
        Effect.flatMap(Queue.isShutdown(queue), (isShutdown) =>
          isShutdown && Cause.isInterrupted(cause)
            ? Effect.fail(Option.none<never>())
            : Effect.failCause(Cause.map(cause, Option.some)),
        ),
      ),
      Effect.flatMap((chunk) =>
        Chunk.isEmpty(chunk)
          ? Effect.fail(Option.none<never>())
          : Effect.succeed(chunk),
      ),
    ),
  );
