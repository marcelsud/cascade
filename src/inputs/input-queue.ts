import { Cause, Effect, Queue, Stream } from "effect";
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
 * `Queue.shutdown` discards buffered values and interrupts pending takes.
 * This adapter treats explicit close as normal stream completion. A producer
 * cannot signal
 * completion by shutting the queue down. Instead it flips `isProducerDone`
 * once every offer has resolved; this stream drains what is left and then
 * ends. An explicit `Queue.shutdown` (from `close()`) still ends it at once.
 *
 * Chunks stay bounded by `Stream.DefaultChunkSize`, matching what
 * the standard queue stream pulls. Taking the whole queue instead would hold up to
 * another full capacity outside the queue while a chunk is processed, which
 * loosens `block` backpressure and changes `drop_new`/`drop_old` outcomes
 * whenever `queueSize` exceeds that bound.
 */
export const streamInputQueue = <A>(
  queue: Queue.Queue<A>,
  isProducerDone: () => boolean = () => false,
): Stream.Stream<A> =>
  Stream.fromIterableEffectRepeat(
    Effect.suspend(() =>
      isProducerDone() && Queue.sizeUnsafe(queue) === 0
        ? Cause.done()
        : Queue.takeBetween(queue, 1, Stream.DefaultChunkSize),
    ).pipe(
      Effect.catchCause((cause) =>
        queue.state._tag === "Done" && Cause.hasInterrupts(cause)
          ? Cause.done()
          : Effect.failCause(cause),
      ),
      Effect.flatMap((chunk) =>
        chunk.length === 0 ? Cause.done() : Effect.succeed(chunk),
      ),
    ),
  );
