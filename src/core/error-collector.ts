/**
 * Bounded failure sampler owned by a single pipeline run.
 *
 * Historical diagnostics are capped; terminal close/drain diagnostics and a
 * fixed pair of fatal causes are retained separately. Strong identity state
 * for the historical sample stays capped — dropped object identities are
 * tracked in a WeakSet so they remain dedupable without pinning heap graphs.
 * Dropped primitive observations are counted without retaining their values,
 * so post-cap primitive traffic cannot grow collector memory.
 *
 * Not part of the public package surface — import this module directly.
 */
import { isFatalError } from "./errors.js";

/** Max historical nonfatal failure objects retained for diagnostics. */
export const MAX_RETAINED_HISTORICAL_ERRORS = 100;

/**
 * Max additional distinct fatal causes retained beyond the fixed first/current
 * fatal slots. Further fatals are counted via `omitted` only (when they also
 * miss the historical sample).
 */
export const MAX_ADDITIONAL_FATAL_SAMPLES = 8;

/**
 * Sentinel for "no fatal cause recorded yet". Distinct from `undefined`, which
 * is a valid Effect failure value and must be retainable as a real diagnostic.
 */
export const NO_FATAL_CAUSE: unique symbol = Symbol("cascade.noFatalCause");
/** Slot holding either {@link NO_FATAL_CAUSE} or a recorded fatal diagnostic. */
export type FatalCauseSlot = unknown;

export interface ErrorCollector {
  retained: unknown[];
  /** Strong identities for the retained historical sample only (≤ MAX). */
  retainedSeen: Set<unknown>;
  /** Non-owning identity tracking for dropped historical object errors. */
  droppedObjects: WeakSet<object>;
  /**
   * First distinct fatal observed this run (fixed slot). May equal
   * {@link NO_FATAL_CAUSE} when none has been seen.
   */
  firstFatal: FatalCauseSlot;
  /**
   * Additional distinct fatal samples beyond first/current, capped.
   * Does not include the first fatal or the live current-cause slot held by
   * the pipeline runner.
   */
  extraFatals: unknown[];
  /** Strong identities for firstFatal + extraFatals (bounded). */
  fatalSeen: Set<unknown>;
  /** Unique-or-observed historical diagnostics counted into the sampler. */
  total: number;
  /**
   * Over-cap historical nonfatal diagnostics not held in any sample:
   * objects once (WeakSet dedupe); primitives per observation.
   */
  omitted: number;
  /**
   * Fatal overflow observations past first/extra that also miss the historical
   * retained sample. Objects once (WeakSet dedupe); primitives per observation.
   * Final reported omissions subtract one at assembly when the live current
   * fatal is held only in that slot (not first/extra/retained).
   */
  fatalOverflowOmitted: number;
  /** Close/drain diagnostics — not subject to the historical retention cap. */
  terminal: unknown[];
}

export const createErrorCollector = (): ErrorCollector => ({
  retained: [],
  retainedSeen: new Set<unknown>(),
  droppedObjects: new WeakSet<object>(),
  firstFatal: NO_FATAL_CAUSE,
  extraFatals: [],
  fatalSeen: new Set<unknown>(),
  total: 0,
  omitted: 0,
  fatalOverflowOmitted: 0,
  terminal: [],
});

const hasHistoricalIdentity = (
  collector: ErrorCollector,
  error: unknown,
): boolean => {
  if (collector.retainedSeen.has(error)) {
    return true;
  }
  // Dropped primitives are not retained; only objects stay dedupable post-cap.
  return (
    ((typeof error === "object" && error !== null) ||
      typeof error === "function") &&
    collector.droppedObjects.has(error)
  );
};

/**
 * Record a distinct fatal cause into fixed/bounded fatal slots.
 * - `duplicate`: identity already in fatalSeen
 * - `recorded`: stored in firstFatal or extraFatals
 * - `overflow`: new identity past fatal sample capacity (not stored there)
 */
export const noteFatalCause = (
  collector: ErrorCollector,
  error: unknown,
): "duplicate" | "recorded" | "overflow" => {
  if (collector.fatalSeen.has(error)) {
    return "duplicate";
  }

  if (collector.firstFatal === NO_FATAL_CAUSE) {
    collector.firstFatal = error;
    collector.fatalSeen.add(error);
    return "recorded";
  }

  if (collector.extraFatals.length < MAX_ADDITIONAL_FATAL_SAMPLES) {
    collector.extraFatals.push(error);
    collector.fatalSeen.add(error);
    return "recorded";
  }

  return "overflow";
};

const isObjectIdentity = (
  error: unknown,
): error is object | ((...args: never[]) => unknown) =>
  (typeof error === "object" && error !== null) || typeof error === "function";

/** Push into the capped historical sample, or drop with identity tracking. */
const retainOrDropHistorical = (
  collector: ErrorCollector,
  error: unknown,
  onDrop: () => void,
): void => {
  if (collector.retained.length < MAX_RETAINED_HISTORICAL_ERRORS) {
    collector.retained.push(error);
    collector.retainedSeen.add(error);
    return;
  }

  onDrop();
  if (isObjectIdentity(error)) {
    collector.droppedObjects.add(error);
  }
};

/** Mutate collector in place: O(1) identity dedup + capped strong retention. */
export const collectHistoricalError = (
  collector: ErrorCollector,
  error: unknown,
): ErrorCollector => {
  if (hasHistoricalIdentity(collector, error)) {
    return collector;
  }

  if (isFatalError(error)) {
    const fatalStatus = noteFatalCause(collector, error);
    if (fatalStatus === "duplicate") {
      // Same fatal identity already recorded via fatal slots.
      return collector;
    }
    collector.total += 1;
    // Overflow fatals that still fit in the historical sample are retained
    // there and are not counted as omitted. Past the historical cap, fatal-
    // slot overflows are tracked separately so a live current-fatal slot that
    // only holds an overflow is not double-counted as missing at assembly.
    retainOrDropHistorical(collector, error, () => {
      if (fatalStatus === "overflow") {
        collector.fatalOverflowOmitted += 1;
      }
    });
    return collector;
  }

  collector.total += 1;
  // Over-cap historical nonfatal: drop the sample and count it. Objects keep
  // identity in WeakSet for dedupe; primitives are not retained after the
  // cap — each observation increments omitted (no stored primitive identity).
  retainOrDropHistorical(collector, error, () => {
    collector.omitted += 1;
  });
  return collector;
};

/**
 * Always retain terminal close/drain diagnostics (uncapped).
 * Dedup only against terminal + actually retained samples — never against
 * dropped historical identities, so a close error reused after being omitted
 * from the sample remains observable.
 *
 * `undefined` is a valid diagnostic value and is retained.
 */
export const collectTerminalError = (
  collector: ErrorCollector,
  error: unknown,
): ErrorCollector => {
  // Terminal list stays tiny (close/drain); linear scan is fine and bounded.
  if (collector.terminal.includes(error) || collector.retainedSeen.has(error)) {
    return collector;
  }
  collector.terminal.push(error);
  return collector;
};

/**
 * Strong references held by historical-sample identity state.
 * Must stay ≤ MAX after the cap (dropped primitives must not grow this).
 */
export const strongHistoricalIdentityCount = (
  collector: ErrorCollector,
): number => collector.retainedSeen.size;

/**
 * Strong references held by fatal identity state (first + extra samples).
 * Must stay ≤ 1 + MAX_ADDITIONAL_FATAL_SAMPLES.
 */
export const strongFatalIdentityCount = (collector: ErrorCollector): number =>
  collector.fatalSeen.size;

/**
 * Append unique diagnostics into `errors` via identity Set.
 * `undefined` is a real value and is retained when first seen.
 */
const pushUniqueError = (
  errors: unknown[],
  seen: Set<unknown>,
  error: unknown,
): void => {
  if (seen.has(error)) {
    return;
  }
  seen.add(error);
  errors.push(error);
};

/**
 * Assemble the public diagnostic sample:
 * primary (if any) → current fatal → first fatal → extra fatals → retained →
 * terminal → additional. Single identity pass.
 *
 * Pass `hasCurrentFatal: true` when the current-fatal slot is occupied — even
 * when the cause value is `undefined`.
 */
export const assembleErrorSample = (parts: {
  readonly primary?: unknown;
  readonly hasPrimary?: boolean;
  readonly currentFatal?: unknown;
  readonly hasCurrentFatal?: boolean;
  readonly collector: ErrorCollector;
  readonly additional?: readonly unknown[];
}): { readonly errors: unknown[]; readonly errorsOmitted: number } => {
  const errors: unknown[] = [];
  const seen = new Set<unknown>();
  const { collector } = parts;

  if (parts.hasPrimary === true) {
    pushUniqueError(errors, seen, parts.primary);
  }

  if (parts.hasCurrentFatal === true) {
    pushUniqueError(errors, seen, parts.currentFatal);
  }

  if (collector.firstFatal !== NO_FATAL_CAUSE) {
    pushUniqueError(errors, seen, collector.firstFatal);
  }

  for (const error of collector.extraFatals) {
    pushUniqueError(errors, seen, error);
  }
  for (const error of collector.retained) {
    pushUniqueError(errors, seen, error);
  }
  for (const error of collector.terminal) {
    pushUniqueError(errors, seen, error);
  }
  if (parts.additional) {
    for (const error of parts.additional) {
      pushUniqueError(errors, seen, error);
    }
  }

  // Fatal overflows are counted as they arrive; when the live current-fatal
  // slot is the only place holding one of those overflows, that observation is
  // in the returned sample and must not count as omitted.
  let fatalOmitted = collector.fatalOverflowOmitted;
  if (parts.hasCurrentFatal === true && fatalOmitted > 0) {
    const current = parts.currentFatal;
    const heldInFixedOrRetained =
      collector.retainedSeen.has(current) ||
      (collector.firstFatal !== NO_FATAL_CAUSE &&
        Object.is(collector.firstFatal, current)) ||
      collector.extraFatals.some((error) => Object.is(error, current));
    if (!heldInFixedOrRetained) {
      fatalOmitted -= 1;
    }
  }

  return {
    errors,
    errorsOmitted: collector.omitted + fatalOmitted,
  };
};
