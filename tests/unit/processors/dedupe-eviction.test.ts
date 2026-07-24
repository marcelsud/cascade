import { describe, it, expect, vi, afterEach } from "vitest";
import { Effect } from "effect";
import { createDedupeProcessor } from "../../../src/processors/dedupe-processor.js";
import type { Message } from "../../../src/core/types.js";

/**
 * Helper: create a message with explicit id for deterministic testing.
 */
const makeMsg = (
  id: string,
  content: Record<string, unknown>,
  metadata: Record<string, unknown> = {},
): Message => ({
  id,
  content,
  metadata,
  timestamp: Date.now(),
});

/**
 * Helper: run the processor and return the result or error.
 */
const runProcess = (
  processor: ReturnType<typeof createDedupeProcessor>,
  msg: Message,
) => Effect.runPromise(Effect.either(processor.process(msg)));

/**
 * Helper: assert that result is Right and the message passed through.
 */
const expectPassThrough = (
  result: { _tag: string; right?: unknown },
  msgId: string,
) => {
  expect(result._tag).toBe("Right");
  if (result._tag === "Right") {
    expect(result.right).toEqual(expect.objectContaining({ id: msgId }));
  }
};

/**
 * Helper: assert that result is Right and the message was suppressed.
 */
const expectSuppressed = (result: { _tag: string; right?: unknown }) => {
  expect(result._tag).toBe("Right");
  if (result._tag === "Right") {
    expect(result.right).toEqual([]);
  }
};

describe("Dedupe Eviction Behavior", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("maxKeys overflow eviction", () => {
    it("should evict oldest entry when maxKeys is exceeded", async () => {
      const processor = createDedupeProcessor({
        key: "id",
        maxKeys: 2,
        windowMs: 60_000,
      });

      // Insert 2 keys (fills to capacity)
      await runProcess(processor, makeMsg("m1", { id: "A" }));
      await runProcess(processor, makeMsg("m2", { id: "B" }));

      let metrics = await Effect.runPromise(processor.getMetrics());
      expect(metrics.activeKeys).toBe(2);

      // Insert a 3rd key — should evict oldest ("A")
      await runProcess(processor, makeMsg("m3", { id: "C" }));

      metrics = await Effect.runPromise(processor.getMetrics());
      expect(metrics.activeKeys).toBe(2);

      // "A" was evicted, so processing it again should be first-seen (pass through)
      const rA = await runProcess(processor, makeMsg("m4", { id: "A" }));
      expectPassThrough(rA, "m4");
    });

    it("should retain newest entries after overflow eviction", async () => {
      const processor = createDedupeProcessor({
        key: "id",
        maxKeys: 3,
        windowMs: 60_000,
      });

      // Insert A, B, C (all fit)
      await runProcess(processor, makeMsg("m1", { id: "A" }));
      await runProcess(processor, makeMsg("m2", { id: "B" }));
      await runProcess(processor, makeMsg("m3", { id: "C" }));

      // Insert D — evicts A (oldest). State: {B, C, D}
      await runProcess(processor, makeMsg("m4", { id: "D" }));

      // A was evicted — accepted again
      const rA = await runProcess(processor, makeMsg("m5", { id: "A" }));
      expectPassThrough(rA, "m5");

      // C and D should still be suppressed (they were not evicted)
      const rC = await runProcess(processor, makeMsg("m6", { id: "C" }));
      const rD = await runProcess(processor, makeMsg("m7", { id: "D" }));
      expectSuppressed(rC);
      expectSuppressed(rD);
    });

    it("should handle maxKeys=1 correctly", async () => {
      const processor = createDedupeProcessor({
        key: "id",
        maxKeys: 1,
        windowMs: 60_000,
      });

      // First key passes through
      const r1 = await runProcess(processor, makeMsg("m1", { id: "A" }));
      expectPassThrough(r1, "m1");

      let metrics = await Effect.runPromise(processor.getMetrics());
      expect(metrics.activeKeys).toBe(1);

      // Duplicate of A is still suppressed
      const r2 = await runProcess(processor, makeMsg("m2", { id: "A" }));
      expectSuppressed(r2);

      // New key B evicts A
      const r3 = await runProcess(processor, makeMsg("m3", { id: "B" }));
      expectPassThrough(r3, "m3");

      metrics = await Effect.runPromise(processor.getMetrics());
      expect(metrics.activeKeys).toBe(1);

      // A is no longer tracked — passes through again
      const r4 = await runProcess(processor, makeMsg("m4", { id: "A" }));
      expectPassThrough(r4, "m4");
    });

    it("should not evict when exactly at maxKeys (no overflow)", async () => {
      const processor = createDedupeProcessor({
        key: "id",
        maxKeys: 3,
        windowMs: 60_000,
      });

      await runProcess(processor, makeMsg("m1", { id: "A" }));
      await runProcess(processor, makeMsg("m2", { id: "B" }));
      await runProcess(processor, makeMsg("m3", { id: "C" }));

      const metrics = await Effect.runPromise(processor.getMetrics());
      expect(metrics.activeKeys).toBe(3);

      // All three keys should still suppress duplicates (no eviction happened)
      const rA = await runProcess(processor, makeMsg("m4", { id: "A" }));
      const rB = await runProcess(processor, makeMsg("m5", { id: "B" }));
      const rC = await runProcess(processor, makeMsg("m6", { id: "C" }));

      expectSuppressed(rA);
      expectSuppressed(rB);
      expectSuppressed(rC);
    });

    it("should cascade evictions across sequential new-key insertions", async () => {
      const processor = createDedupeProcessor({
        key: "id",
        maxKeys: 2,
        windowMs: 60_000,
      });

      // Insert A, B (full). State: {A, B}
      await runProcess(processor, makeMsg("m1", { id: "A" }));
      await runProcess(processor, makeMsg("m2", { id: "B" }));

      // Insert C → evicts A. State: {B, C}
      await runProcess(processor, makeMsg("m3", { id: "C" }));
      // Insert D → evicts B. State: {C, D}
      await runProcess(processor, makeMsg("m4", { id: "D" }));

      const metrics = await Effect.runPromise(processor.getMetrics());
      expect(metrics.activeKeys).toBe(2);

      // A and B were evicted — should pass through again
      const rA = await runProcess(processor, makeMsg("m5", { id: "A" }));
      const rB = await runProcess(processor, makeMsg("m6", { id: "B" }));
      expectPassThrough(rA, "m5");
      expectPassThrough(rB, "m6");
    });

    it("should correctly track metrics through eviction cycles", async () => {
      const processor = createDedupeProcessor({
        key: "id",
        maxKeys: 2,
        windowMs: 60_000,
      });

      // A (miss), B (miss). State: {A, B}
      await runProcess(processor, makeMsg("m1", { id: "A" }));
      await runProcess(processor, makeMsg("m2", { id: "B" }));

      // C (miss, evicts A). State: {B, C}
      await runProcess(processor, makeMsg("m3", { id: "C" }));

      // A again — evicted so miss (evicts B). State: {C, A}
      await runProcess(processor, makeMsg("m4", { id: "A" }));

      // A duplicate — hit. State: {C, A}
      const rDup = await runProcess(processor, makeMsg("m5", { id: "A" }));
      expectSuppressed(rDup);

      const metrics = await Effect.runPromise(processor.getMetrics());
      expect(metrics.dedupeMisses).toBe(4); // A, B, C, A (re-insert)
      expect(metrics.dedupeHits).toBe(1); // A duplicate
      expect(metrics.activeKeys).toBe(2); // C, A
    });

    it("should evict by insertion order, not by access order", async () => {
      const processor = createDedupeProcessor({
        key: "id",
        maxKeys: 2,
        windowMs: 60_000,
      });

      // Insert A, B. State: {A, B}
      await runProcess(processor, makeMsg("m1", { id: "A" }));
      await runProcess(processor, makeMsg("m2", { id: "B" }));

      // Duplicate of A (hit, no state mutation to insertion order)
      const rDupA = await runProcess(processor, makeMsg("m3", { id: "A" }));
      expectSuppressed(rDupA);

      // New key C → should evict A (oldest by insertion order, even though A was accessed more recently)
      await runProcess(processor, makeMsg("m4", { id: "C" }));

      const metrics = await Effect.runPromise(processor.getMetrics());
      expect(metrics.activeKeys).toBe(2);

      // A was evicted despite being recently accessed as a duplicate
      const rA = await runProcess(processor, makeMsg("m5", { id: "A" }));
      expectPassThrough(rA, "m5");

      // C should still be tracked (it was just inserted)
      const rC = await runProcess(processor, makeMsg("m6", { id: "C" }));
      expectSuppressed(rC);
    });

    it("should handle eviction combined with window expiry", async () => {
      const processor = createDedupeProcessor({
        key: "id",
        maxKeys: 3,
        windowMs: 50,
      });

      // Insert A, B, C
      await runProcess(processor, makeMsg("m1", { id: "A" }));
      await runProcess(processor, makeMsg("m2", { id: "B" }));
      await runProcess(processor, makeMsg("m3", { id: "C" }));

      // Wait for all entries to expire
      await new Promise((resolve) => setTimeout(resolve, 80));

      // Insert D — expired entries are evicted first by windowMs, then D is inserted
      await runProcess(processor, makeMsg("m4", { id: "D" }));

      const metrics = await Effect.runPromise(processor.getMetrics());
      // Only D should be active (A, B, C expired before overflow check)
      expect(metrics.activeKeys).toBe(1);
      expect(metrics.dedupeMisses).toBe(4);
    });

    it("should evict only one entry when capacity exceeded by one", async () => {
      const processor = createDedupeProcessor({
        key: "id",
        maxKeys: 3,
        windowMs: 60_000,
      });

      // Fill to capacity: A, B, C. State: {A, B, C}
      await runProcess(processor, makeMsg("m1", { id: "A" }));
      await runProcess(processor, makeMsg("m2", { id: "B" }));
      await runProcess(processor, makeMsg("m3", { id: "C" }));

      // Insert D → evicts only A (oldest). State: {B, C, D}
      await runProcess(processor, makeMsg("m4", { id: "D" }));

      const metrics = await Effect.runPromise(processor.getMetrics());
      expect(metrics.activeKeys).toBe(3);

      // A was evicted
      const rA = await runProcess(processor, makeMsg("m5", { id: "A" }));
      expectPassThrough(rA, "m5");

      // D still tracked (newest)
      const rD = await runProcess(processor, makeMsg("m6", { id: "D" }));
      expectSuppressed(rD);
    });

    it("should work correctly with metadata keys under eviction pressure", async () => {
      const processor = createDedupeProcessor({
        key: "metadata.requestId",
        maxKeys: 2,
        windowMs: 60_000,
      });

      // Insert req-1, req-2. State: {req-1, req-2}
      await runProcess(
        processor,
        makeMsg("m1", { data: "a" }, { requestId: "req-1" }),
      );
      await runProcess(
        processor,
        makeMsg("m2", { data: "b" }, { requestId: "req-2" }),
      );

      // Third key evicts req-1. State: {req-2, req-3}
      await runProcess(
        processor,
        makeMsg("m3", { data: "c" }, { requestId: "req-3" }),
      );

      const metrics = await Effect.runPromise(processor.getMetrics());
      expect(metrics.activeKeys).toBe(2);

      // req-1 was evicted — passes through
      const r = await runProcess(
        processor,
        makeMsg("m4", { data: "d" }, { requestId: "req-1" }),
      );
      expectPassThrough(r, "m4");

      // req-3 still tracked (newest, not evicted by req-1 re-insert since req-2 is oldest)
      const r3 = await runProcess(
        processor,
        makeMsg("m5", { data: "e" }, { requestId: "req-3" }),
      );
      expectSuppressed(r3);
    });

    it("should maintain state size at exactly maxKeys after multiple overflows", async () => {
      const processor = createDedupeProcessor({
        key: "id",
        maxKeys: 2,
        windowMs: 60_000,
      });

      // Insert 10 unique keys sequentially
      for (let i = 0; i < 10; i++) {
        await runProcess(processor, makeMsg(`m${i}`, { id: `key-${i}` }));
      }

      const metrics = await Effect.runPromise(processor.getMetrics());
      // State should be bounded at maxKeys=2 regardless of total insertions
      expect(metrics.activeKeys).toBe(2);
      expect(metrics.dedupeMisses).toBe(10);
      expect(metrics.dedupeHits).toBe(0);

      // Only the last 2 keys (key-8 and key-9) should be tracked
      const rOld = await runProcess(
        processor,
        makeMsg("check-old", { id: "key-0" }),
      );
      expectPassThrough(rOld, "check-old"); // evicted long ago

      const rRecent = await runProcess(
        processor,
        makeMsg("check-recent", { id: "key-9" }),
      );
      expectSuppressed(rRecent); // still tracked
    });
  });
});
