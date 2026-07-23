import { Effect } from "effect";
import type { Message, Processor } from "./types.js";

/**
 * Run processors sequentially while preserving zero-or-many message results.
 * Messages produced by one stage are processed in order by the next stage.
 */
export const runProcessorChain = <E, R>(
  initial: Message | readonly Message[],
  processors: ReadonlyArray<Processor<E, R>>,
): Effect.Effect<Message[], E, R> =>
  Effect.reduce(
    processors,
    Array.isArray(initial) ? [...initial] : [initial],
    (messages, processor) =>
      Effect.forEach(messages, (message) => processor.process(message), {
        concurrency: 1,
      }).pipe(
        Effect.map((results) =>
          results.flatMap((result) =>
            Array.isArray(result) ? result : [result],
          ),
        ),
      ),
  );
