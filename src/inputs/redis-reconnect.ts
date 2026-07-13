import { Effect } from "effect";

export interface ReconnectPolicy {
  readonly maxReconnectAttempts?: number;
  readonly reconnectBackoffMs?: number;
  readonly maxBackoffMs?: number;
}

export const reconnectDelayMs = (
  attempt: number,
  baseMs: number,
  maxMs = 30_000,
): number => Math.min(baseMs * 2 ** Math.max(0, attempt - 1), maxMs);

/** Retry a typed Redis operation, preserving its final error on exhaustion. */
export const withReconnect = <A, E, R>(
  operation: Effect.Effect<A, E, R>,
  policy: ReconnectPolicy,
  onRetry?: (error: E, attempt: number, delayMs: number) => Effect.Effect<void>,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    let attempt = 0;
    while (true) {
      const result = yield* Effect.either(operation);
      if (result._tag === "Right") return result.right;

      if (
        policy.maxReconnectAttempts !== undefined &&
        attempt >= policy.maxReconnectAttempts
      ) {
        return yield* Effect.fail(result.left);
      }

      attempt += 1;
      const delayMs = reconnectDelayMs(
        attempt,
        policy.reconnectBackoffMs ?? 1_000,
        policy.maxBackoffMs,
      );
      if (onRetry) yield* onRetry(result.left, attempt, delayMs);
      yield* Effect.sleep(`${delayMs} millis`);
    }
  });
