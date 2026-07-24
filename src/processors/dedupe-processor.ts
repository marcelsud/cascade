/**
 * Dedupe Processor - Deduplicates messages by a configured attribute key
 *
 * Maintains in-memory Effect Ref state to track seen keys within a time window.
 * Duplicate messages (same key within window) are suppressed from downstream processing.
 * Emits structured metrics for dedupe hits, misses, and key extraction failures.
 */
import { Effect, Ref } from "effect";
import type { Processor, Message } from "../core/types.js";

export interface DedupeProcessorConfig {
  readonly key: string;
  readonly windowMs?: number;
  readonly maxKeys?: number;
}

export interface DedupeMetrics {
  readonly component: string;
  readonly type: "processor";
  readonly timestamp: number;
  readonly dedupeHits: number;
  readonly dedupeMisses: number;
  readonly extractionFailures: number;
  readonly activeKeys: number;
}

export class DedupeKeyExtractionError {
  readonly _tag = "DedupeKeyExtractionError";
  constructor(
    readonly keyPath: string,
    readonly messageId: string,
    readonly reason: string,
  ) {}

  get message(): string {
    return `Dedupe key extraction failed: path "${this.keyPath}" on message ${this.messageId} — ${this.reason}`;
  }
}

interface DedupeEntry {
  readonly firstSeen: number;
}

interface DedupeCounters {
  readonly hits: number;
  readonly misses: number;
  readonly extractionFailures: number;
}

/**
 * Emit dedupe processor metrics via structured logging.
 * Follows the same pattern as emitInputMetrics/emitOutputMetrics in core/metrics.ts.
 */
export const emitDedupeMetrics = (
  metrics: DedupeMetrics,
): Effect.Effect<void, never, never> =>
  Effect.logInfo("Component metrics", {
    component: metrics.component,
    type: metrics.type,
    dedupeHits: metrics.dedupeHits,
    dedupeMisses: metrics.dedupeMisses,
    extractionFailures: metrics.extractionFailures,
    activeKeys: metrics.activeKeys,
    timestamp: metrics.timestamp,
  });

/**
 * Traverse a dot-path into a nested object structure.
 * Returns the resolved value or undefined if path is unreachable.
 */
const resolveDotPath = (
  obj: Record<string, unknown>,
  dotPath: string,
): unknown => {
  const parts = dotPath.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (
      current &&
      typeof current === "object" &&
      part in (current as Record<string, unknown>)
    ) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
};

/**
 * Extract dedupe key from a message.
 *
 * Extraction order (per design decision #4):
 * 1. Metadata reference when key starts with "metadata." — traverses msg.metadata via dot-path
 * 2. Payload path lookup otherwise — traverses msg.content via dot-path
 *
 * Returns the stringified key value, or undefined if the path resolves to undefined/null.
 */
export const extractKey = (
  keyPath: string,
  msg: Message,
): string | undefined => {
  if (keyPath.startsWith("metadata.")) {
    const metaPath = keyPath.slice("metadata.".length);
    if (metaPath.length === 0) return undefined;
    const value = resolveDotPath(msg.metadata, metaPath);
    return value !== undefined && value !== null ? String(value) : undefined;
  }

  const content = msg.content;
  if (content && typeof content === "object" && !Array.isArray(content)) {
    const value = resolveDotPath(content as Record<string, unknown>, keyPath);
    return value !== undefined && value !== null ? String(value) : undefined;
  }

  return undefined;
};

/**
 * Evict entries older than windowMs from the state map.
 */
const evictExpired = (
  state: Map<string, DedupeEntry>,
  now: number,
  windowMs: number,
): Map<string, DedupeEntry> => {
  const next = new Map(state);
  for (const [k, entry] of next) {
    if (now - entry.firstSeen > windowMs) {
      next.delete(k);
    }
  }
  return next;
};

/**
 * Evict oldest entries if size exceeds maxKeys.
 * Map iteration order is insertion order — first entries are oldest.
 */
const evictOverflow = (
  state: Map<string, DedupeEntry>,
  maxKeys: number,
): Map<string, DedupeEntry> => {
  if (state.size <= maxKeys) return state;
  const next = new Map(state);
  const iter = next.keys();
  while (next.size > maxKeys) {
    const key = iter.next().value;
    if (key !== undefined) {
      next.delete(key);
    } else {
      break;
    }
  }
  return next;
};

/**
 * Create a dedupe processor.
 *
 * Suppresses duplicate messages based on a configured key attribute.
 * Uses Effect Ref for in-memory state management.
 *
 * Key extraction:
 * - Keys starting with "metadata." extract from message metadata
 * - All other keys extract from message payload (content)
 *
 * Duplicate handling:
 * - First-seen keys pass through and are recorded with a timestamp
 * - Repeated keys within windowMs are dropped (returns empty array)
 * - Expired entries are evicted on each invocation
 * - If state exceeds maxKeys, oldest entries are evicted first
 */
export const createDedupeProcessor = (
  config: DedupeProcessorConfig,
): Processor<DedupeKeyExtractionError> & {
  readonly getMetrics: () => Effect.Effect<DedupeMetrics>;
} => {
  const windowMs = config.windowMs ?? 60_000;
  const maxKeys = config.maxKeys ?? 10_000;
  const keyPath = config.key;

  // Effect-safe mutable state via Ref
  const stateRef = Ref.unsafeMake<Map<string, DedupeEntry>>(new Map());
  const countersRef = Ref.unsafeMake<DedupeCounters>({
    hits: 0,
    misses: 0,
    extractionFailures: 0,
  });

  const getMetrics = (): Effect.Effect<DedupeMetrics> =>
    Effect.gen(function* () {
      const counters = yield* Ref.get(countersRef);
      const state = yield* Ref.get(stateRef);
      return {
        component: "dedupe-processor",
        type: "processor" as const,
        timestamp: Date.now(),
        dedupeHits: counters.hits,
        dedupeMisses: counters.misses,
        extractionFailures: counters.extractionFailures,
        activeKeys: state.size,
      };
    });

  return {
    name: "dedupe-processor",
    getMetrics,
    process: (
      msg: Message,
    ): Effect.Effect<Message | Message[], DedupeKeyExtractionError> => {
      return Effect.gen(function* () {
        const now = Date.now();

        // Evict expired entries
        yield* Ref.update(stateRef, (state) =>
          evictExpired(state, now, windowMs),
        );

        // Extract dedupe key — fail with typed error if extraction yields undefined
        const dedupeKey = extractKey(keyPath, msg);
        if (dedupeKey === undefined) {
          yield* Ref.update(countersRef, (c) => ({
            ...c,
            extractionFailures: c.extractionFailures + 1,
          }));
          const reason = keyPath.startsWith("metadata.")
            ? `metadata field "${keyPath.slice("metadata.".length)}" not found or null`
            : `payload path "${keyPath}" not found or null`;
          yield* Effect.logWarning(
            `Dedupe key extraction failed for message ${msg.id}`,
            { keyPath, reason, messageId: msg.id },
          );
          return yield* Effect.fail(
            new DedupeKeyExtractionError(keyPath, msg.id, reason),
          );
        }

        // Check for duplicate
        const state = yield* Ref.get(stateRef);
        if (state.has(dedupeKey)) {
          yield* Ref.update(countersRef, (c) => ({
            ...c,
            hits: c.hits + 1,
          }));
          yield* Effect.logDebug(`Dedupe hit: duplicate suppressed`, {
            keyPath,
            dedupeKey,
            messageId: msg.id,
          });
          return [] as Message[];
        }

        // First-seen: record and pass through
        yield* Ref.update(stateRef, (s) => {
          const next = new Map(s);
          next.set(dedupeKey, { firstSeen: now });
          return evictOverflow(next, maxKeys);
        });

        yield* Ref.update(countersRef, (c) => ({
          ...c,
          misses: c.misses + 1,
        }));

        yield* Effect.logDebug(`Dedupe miss: first-seen key accepted`, {
          keyPath,
          dedupeKey,
          messageId: msg.id,
        });

        return msg;
      });
    },
  };
};
