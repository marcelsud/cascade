## Context

Cascade currently has no built-in way to suppress duplicated messages during processing. Upstream systems (webhooks, queues, retries, at-least-once delivery) can legitimately deliver the same logical event more than once, which can cause repeated side effects in downstream outputs.

The proposed `dedupe` processor adds a pipeline-level guard by computing a dedupe key from a configured message attribute (payload path or metadata field) and dropping repeated keys in a configurable time window. The implementation must fit existing processor patterns (Effect-based processor factories, schema validation, and stream processing).

## Goals / Non-Goals

**Goals:**

- Add a `dedupe` processor configurable in YAML and available in pipeline build/registry.
- Let users define which attribute is used as the dedupe key.
- Skip duplicate messages deterministically so downstream processors/outputs only see first-seen keys within the dedupe window.
- Provide clear config validation and runtime errors for missing/invalid dedupe key extraction.
- Expose observability signals (logs and metrics) for dedupe hits/misses.

**Non-Goals:**

- Global deduplication across multiple process instances or restarts.
- Exactly-once processing guarantees across distributed systems.
- Persistent dedupe storage (Redis/database) in this change.
- Content-hash dedupe of full payloads when no key is provided.

## Decisions

### 1) Processor contract and config shape

Use a dedicated processor type `dedupe` with explicit config:

- `key`: required selector for the dedupe key (supports payload path and metadata prefix)
- `windowMs`: optional dedupe retention window (default value defined in implementation)
- `maxKeys`: optional in-memory bound to cap retained keys and avoid unbounded growth

**Rationale:** Explicit config is easier to validate and document than implicit behavior.

**Alternatives considered:**

- Reusing existing mapping processor for dedupe: rejected, because dedupe is stateful behavior and deserves explicit semantics.
- Making key optional and hashing full message: rejected to avoid accidental expensive hashing and unstable dedupe behavior.

### 2) State management model

Maintain dedupe state in-memory inside the processor instance using Effect-safe mutable state (`Ref`) keyed by dedupe key with first-seen timestamp.

**Rationale:** Aligns with existing runtime model and keeps implementation dependency-free.

**Alternatives considered:**

- External store (Redis) for shared dedupe: rejected for initial scope and operational complexity.
- Stateless dedupe: not feasible for duplicate detection over time.

### 3) Duplicate handling behavior

If key is already seen within `windowMs`, treat the message as duplicate and short-circuit by marking and dropping it from downstream processing path.

**Rationale:** Preventing repeated side effects is the primary motivation.

**Alternatives considered:**

- Forward duplicates with metadata flag only: rejected because outputs could still trigger side effects.
- Hard-fail on duplicates: rejected because duplicates are expected in many systems.

### 4) Key extraction semantics

Support deterministic extraction order:

1. Metadata reference when key starts with `metadata.`
2. Payload path lookup otherwise

If extraction yields empty/undefined, return a typed processor error with actionable context (configured key path and message id).

**Rationale:** Predictable behavior and easier debugging.

**Alternatives considered:**

- Silent pass-through on missing key: rejected; it hides configuration mistakes.

### 5) Memory and cleanup strategy

On each processed message, evict expired entries (older than `windowMs`). If size exceeds `maxKeys`, evict oldest entries first.

**Rationale:** Keeps memory bounded in long-running pipelines.

**Alternatives considered:**

- No eviction: rejected due to memory growth risk.
- Timer-based background cleanup: rejected for unnecessary complexity in first version.

## Risks / Trade-offs

- [Process-local dedupe only] -> Mitigation: document scope clearly and consider future external-store strategy.
- [Incorrect key path configuration drops expected messages or misses duplicates] -> Mitigation: strict schema validation and explicit runtime errors.
- [Large key cardinality can increase memory/cpu] -> Mitigation: `windowMs` + `maxKeys` bounds and eviction policy.
- [Dropping duplicates may hide upstream quality issues] -> Mitigation: increment dedupe metrics and structured logs for duplicate events.

## Migration Plan

1. Add processor schema/type and registry wiring.
2. Implement `dedupe` processor with key extraction, state handling, and eviction.
3. Add docs and example config showing attribute-based dedupe.
4. Add unit tests for key extraction, duplicate detection, eviction, and error cases.
5. Add integration/e2e scenario validating downstream suppression of duplicates.

Rollback strategy: remove `dedupe` processor from configs (or feature branch revert) to restore prior pass-through behavior.

## Open Questions

- Should default `windowMs` be conservative (short) or safety-first (long)?
- For duplicates, should metrics include the key value or only counts to avoid sensitive data leakage?
- Should initial version support nested arrays/object path edge cases, or limit to scalar extracted keys?
