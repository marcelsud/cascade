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
const isPlainObject = (value: object): boolean => {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/**
 * Walk the raw value graph before JSON.stringify. JSON.stringify runs
 * `toJSON` before the replacer, so nested Date/Map/custom hosts would
 * otherwise collapse into strings/objects and collide with distinct keys.
 */
const isJsonSafeKeyValue = (value: unknown, seen: WeakSet<object>): boolean => {
  if (value === null) {
    return true;
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (
    value === undefined ||
    typeof value === "function" ||
    typeof value === "symbol" ||
    typeof value === "bigint"
  ) {
    return false;
  }
  if (typeof value !== "object") {
    return false;
  }
  if (seen.has(value)) {
    return false;
  }
  // JSON.stringify invokes toJSON before visiting children — reject any host
  // (including arrays) that customizes serialization.
  if ("toJSON" in value && typeof value.toJSON === "function") {
    return false;
  }
  if (Array.isArray(value)) {
    seen.add(value);
    for (const item of value) {
      if (!isJsonSafeKeyValue(item, seen)) {
        return false;
      }
    }
    return true;
  }
  if (!isPlainObject(value)) {
    return false;
  }
  seen.add(value);
  for (const nested of Object.values(value as Record<string, unknown>)) {
    if (!isJsonSafeKeyValue(nested, seen)) {
      return false;
    }
  }
  return true;
};

const stringifyKeyValue = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : undefined;
  }
  if (typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value !== null && typeof value === "object") {
    // Only plain objects/arrays without toJSON hosts get stable JSON keys.
    if (!isJsonSafeKeyValue(value, new WeakSet())) {
      return undefined;
    }
    try {
      const serialized = JSON.stringify(value);
      return typeof serialized === "string" ? serialized : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
};

export const extractKey = (
  keyPath: string,
  msg: Message,
): string | undefined => {
  if (keyPath.startsWith("metadata.")) {
    const metaPath = keyPath.slice("metadata.".length);
    if (metaPath.length === 0) return undefined;
    const value = resolveDotPath(msg.metadata, metaPath);
    return value !== undefined && value !== null
      ? stringifyKeyValue(value)
      : undefined;
  }

  const content = msg.content;
  if (content && typeof content === "object" && !Array.isArray(content)) {
    const value = resolveDotPath(content as Record<string, unknown>, keyPath);
    return value !== undefined && value !== null
      ? stringifyKeyValue(value)
      : undefined;
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
  // Bounded component-metrics cadence (same shape as stdout-output).
  // Processors have no close hook, so count-based emission is the whole mechanism.
  let messageCount = 0;

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

        const emitOnCadence = () =>
          Effect.gen(function* () {
            messageCount++;
            if (messageCount >= 100) {
              yield* emitDedupeMetrics(yield* getMetrics());
              messageCount = 0;
            }
          });

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
          // Count failed attempts toward the cadence so extractionFailures
          // appear in the next coherent post-update snapshot.
          yield* emitOnCadence();
          return yield* Effect.fail(
            new DedupeKeyExtractionError(keyPath, msg.id, reason),
          );
        }

        // Atomic admission: expire → membership → insert+overflow on miss.
        // One Ref.modify so concurrent first-seen for the same key is linearizable.
        const isDuplicate = yield* Ref.modify(stateRef, (state) => {
          const afterExpiry = evictExpired(state, now, windowMs);
          if (afterExpiry.has(dedupeKey)) {
            return [true, afterExpiry] as const;
          }
          const next = new Map(afterExpiry);
          next.set(dedupeKey, { firstSeen: now });
          return [false, evictOverflow(next, maxKeys)] as const;
        });

        if (isDuplicate) {
          yield* Ref.update(countersRef, (c) => ({
            ...c,
            hits: c.hits + 1,
          }));
          yield* Effect.logDebug(`Dedupe hit: duplicate suppressed`, {
            keyPath,
            dedupeKey,
            messageId: msg.id,
          });
          yield* emitOnCadence();
          return [] as Message[];
        }

        yield* Ref.update(countersRef, (c) => ({
          ...c,
          misses: c.misses + 1,
        }));

        yield* Effect.logDebug(`Dedupe miss: first-seen key accepted`, {
          keyPath,
          dedupeKey,
          messageId: msg.id,
        });

        yield* emitOnCadence();
        return msg;
      });
    },
  };
};
