import { describe, it, expect, vi, afterEach } from "vitest";
import { Effect } from "effect";
import {
  createDedupeProcessor,
  DedupeKeyExtractionError,
} from "../../../src/processors/dedupe-processor.js";
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
) =>
  Effect.runPromise(
    Effect.either(processor.process(msg)),
  );

describe("Dedupe Suppression, First-Seen Pass-Through, and Expiry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("first-seen pass-through", () => {
    it("should pass through a message when key is seen for the first time", async () => {
      const processor = createDedupeProcessor({ key: "orderId" });
      const msg = makeMsg("m1", { orderId: "order-1" });

      const result = await runProcess(processor, msg);

      expect(result._tag).toBe("Right");
      if (result._tag === "Right") {
        expect(result.right).toBe(msg);
      }
    });

    it("should pass through messages with different keys", async () => {
      const processor = createDedupeProcessor({ key: "orderId" });
      const msg1 = makeMsg("m1", { orderId: "order-1" });
      const msg2 = makeMsg("m2", { orderId: "order-2" });
      const msg3 = makeMsg("m3", { orderId: "order-3" });

      const r1 = await runProcess(processor, msg1);
      const r2 = await runProcess(processor, msg2);
      const r3 = await runProcess(processor, msg3);

      expect(r1._tag).toBe("Right");
      expect(r2._tag).toBe("Right");
      expect(r3._tag).toBe("Right");
      if (r1._tag === "Right") expect(r1.right).toBe(msg1);
      if (r2._tag === "Right") expect(r2.right).toBe(msg2);
      if (r3._tag === "Right") expect(r3.right).toBe(msg3);
    });

    it("should record first-seen miss in metrics", async () => {
      const processor = createDedupeProcessor({ key: "orderId" });
      const msg = makeMsg("m1", { orderId: "order-1" });

      await runProcess(processor, msg);
      const metrics = await Effect.runPromise(processor.getMetrics());

      expect(metrics.dedupeMisses).toBe(1);
      expect(metrics.dedupeHits).toBe(0);
      expect(metrics.activeKeys).toBe(1);
    });
  });

  describe("duplicate suppression", () => {
    it("should suppress a duplicate message with the same key", async () => {
      const processor = createDedupeProcessor({ key: "orderId" });
      const msg1 = makeMsg("m1", { orderId: "order-1" });
      const msg2 = makeMsg("m2", { orderId: "order-1" });

      const r1 = await runProcess(processor, msg1);
      const r2 = await runProcess(processor, msg2);

      expect(r1._tag).toBe("Right");
      if (r1._tag === "Right") expect(r1.right).toBe(msg1);

      expect(r2._tag).toBe("Right");
      if (r2._tag === "Right") {
        expect(r2.right).toEqual([]);
      }
    });

    it("should suppress multiple duplicates of the same key", async () => {
      const processor = createDedupeProcessor({ key: "eventId" });
      const first = makeMsg("m1", { eventId: "evt-1" });
      const dup1 = makeMsg("m2", { eventId: "evt-1" });
      const dup2 = makeMsg("m3", { eventId: "evt-1" });
      const dup3 = makeMsg("m4", { eventId: "evt-1" });

      const r0 = await runProcess(processor, first);
      const r1 = await runProcess(processor, dup1);
      const r2 = await runProcess(processor, dup2);
      const r3 = await runProcess(processor, dup3);

      expect(r0._tag).toBe("Right");
      if (r0._tag === "Right") expect(r0.right).toBe(first);

      for (const r of [r1, r2, r3]) {
        expect(r._tag).toBe("Right");
        if (r._tag === "Right") expect(r.right).toEqual([]);
      }
    });

    it("should suppress duplicates independently per key", async () => {
      const processor = createDedupeProcessor({ key: "orderId" });
      const a1 = makeMsg("a1", { orderId: "A" });
      const b1 = makeMsg("b1", { orderId: "B" });
      const a2 = makeMsg("a2", { orderId: "A" });
      const b2 = makeMsg("b2", { orderId: "B" });

      const ra1 = await runProcess(processor, a1);
      const rb1 = await runProcess(processor, b1);
      const ra2 = await runProcess(processor, a2);
      const rb2 = await runProcess(processor, b2);

      // First-seen for both keys pass through
      expect(ra1._tag).toBe("Right");
      if (ra1._tag === "Right") expect(ra1.right).toBe(a1);
      expect(rb1._tag).toBe("Right");
      if (rb1._tag === "Right") expect(rb1.right).toBe(b1);

      // Duplicates suppressed
      expect(ra2._tag).toBe("Right");
      if (ra2._tag === "Right") expect(ra2.right).toEqual([]);
      expect(rb2._tag).toBe("Right");
      if (rb2._tag === "Right") expect(rb2.right).toEqual([]);
    });

    it("should track dedupe hit metrics", async () => {
      const processor = createDedupeProcessor({ key: "orderId" });
      const msg = makeMsg("m1", { orderId: "order-1" });
      const dup = makeMsg("m2", { orderId: "order-1" });

      await runProcess(processor, msg);
      await runProcess(processor, dup);
      const metrics = await Effect.runPromise(processor.getMetrics());

      expect(metrics.dedupeMisses).toBe(1);
      expect(metrics.dedupeHits).toBe(1);
      expect(metrics.activeKeys).toBe(1);
    });

    it("should suppress duplicate using metadata key", async () => {
      const processor = createDedupeProcessor({ key: "metadata.requestId" });
      const msg1 = makeMsg("m1", { data: "a" }, { requestId: "req-1" });
      const msg2 = makeMsg("m2", { data: "b" }, { requestId: "req-1" });

      const r1 = await runProcess(processor, msg1);
      const r2 = await runProcess(processor, msg2);

      expect(r1._tag).toBe("Right");
      if (r1._tag === "Right") expect(r1.right).toBe(msg1);

      expect(r2._tag).toBe("Right");
      if (r2._tag === "Right") expect(r2.right).toEqual([]);
    });

    it("should suppress duplicate using nested payload key", async () => {
      const processor = createDedupeProcessor({ key: "event.id" });
      const msg1 = makeMsg("m1", { event: { id: "e-1" } });
      const msg2 = makeMsg("m2", { event: { id: "e-1" } });

      const r1 = await runProcess(processor, msg1);
      const r2 = await runProcess(processor, msg2);

      expect(r1._tag).toBe("Right");
      if (r1._tag === "Right") expect(r1.right).toBe(msg1);

      expect(r2._tag).toBe("Right");
      if (r2._tag === "Right") expect(r2.right).toEqual([]);
    });

    it("should return empty array (not undefined/null) for suppressed messages", async () => {
      const processor = createDedupeProcessor({ key: "id" });
      const msg1 = makeMsg("m1", { id: "x" });
      const msg2 = makeMsg("m2", { id: "x" });

      await runProcess(processor, msg1);
      const r = await runProcess(processor, msg2);

      expect(r._tag).toBe("Right");
      if (r._tag === "Right") {
        expect(Array.isArray(r.right)).toBe(true);
        expect((r.right as Message[]).length).toBe(0);
      }
    });
  });

  describe("expiry reprocessing", () => {
    it("should allow reprocessing of a key after window expires", async () => {
      // Use a very short window so we can test expiry
      const processor = createDedupeProcessor({
        key: "orderId",
        windowMs: 50,
      });
      const msg1 = makeMsg("m1", { orderId: "order-1" });
      const msg2 = makeMsg("m2", { orderId: "order-1" });

      // First message passes through
      const r1 = await runProcess(processor, msg1);
      expect(r1._tag).toBe("Right");
      if (r1._tag === "Right") expect(r1.right).toBe(msg1);

      // Wait for the window to expire
      await new Promise((resolve) => setTimeout(resolve, 80));

      // Same key should pass through again after expiry
      const r2 = await runProcess(processor, msg2);
      expect(r2._tag).toBe("Right");
      if (r2._tag === "Right") expect(r2.right).toBe(msg2);
    });

    it("should still suppress duplicates within the window before expiry", async () => {
      const processor = createDedupeProcessor({
        key: "orderId",
        windowMs: 500,
      });
      const msg1 = makeMsg("m1", { orderId: "order-1" });
      const msg2 = makeMsg("m2", { orderId: "order-1" });

      const r1 = await runProcess(processor, msg1);
      // Immediately process duplicate (well within window)
      const r2 = await runProcess(processor, msg2);

      expect(r1._tag).toBe("Right");
      if (r1._tag === "Right") expect(r1.right).toBe(msg1);

      expect(r2._tag).toBe("Right");
      if (r2._tag === "Right") expect(r2.right).toEqual([]);
    });

    it("should track metrics correctly across expiry boundary", async () => {
      const processor = createDedupeProcessor({
        key: "orderId",
        windowMs: 50,
      });
      const msg1 = makeMsg("m1", { orderId: "order-1" });
      const dup = makeMsg("m2", { orderId: "order-1" });
      const reprocess = makeMsg("m3", { orderId: "order-1" });

      await runProcess(processor, msg1); // miss
      await runProcess(processor, dup); // hit

      await new Promise((resolve) => setTimeout(resolve, 80));

      await runProcess(processor, reprocess); // miss (key expired)

      const metrics = await Effect.runPromise(processor.getMetrics());
      expect(metrics.dedupeMisses).toBe(2);
      expect(metrics.dedupeHits).toBe(1);
      expect(metrics.activeKeys).toBe(1);
    });

    it("should expire multiple keys independently", async () => {
      const processor = createDedupeProcessor({
        key: "orderId",
        windowMs: 50,
      });
      const a1 = makeMsg("a1", { orderId: "A" });
      const b1 = makeMsg("b1", { orderId: "B" });

      await runProcess(processor, a1);
      await runProcess(processor, b1);

      // Both keys should be active
      let metrics = await Effect.runPromise(processor.getMetrics());
      expect(metrics.activeKeys).toBe(2);

      // Wait for expiry
      await new Promise((resolve) => setTimeout(resolve, 80));

      // Reprocess both — they should pass through
      const a2 = makeMsg("a2", { orderId: "A" });
      const b2 = makeMsg("b2", { orderId: "B" });
      const ra2 = await runProcess(processor, a2);
      const rb2 = await runProcess(processor, b2);

      expect(ra2._tag).toBe("Right");
      if (ra2._tag === "Right") expect(ra2.right).toBe(a2);
      expect(rb2._tag).toBe("Right");
      if (rb2._tag === "Right") expect(rb2.right).toBe(b2);

      metrics = await Effect.runPromise(processor.getMetrics());
      expect(metrics.activeKeys).toBe(2);
      expect(metrics.dedupeMisses).toBe(4);
    });

    it("should evict expired key and accept new key with same value in same call", async () => {
      const processor = createDedupeProcessor({
        key: "orderId",
        windowMs: 50,
      });
      const msg1 = makeMsg("m1", { orderId: "x" });
      await runProcess(processor, msg1);

      await new Promise((resolve) => setTimeout(resolve, 80));

      // Eviction + insertion happen in same process call
      const msg2 = makeMsg("m2", { orderId: "x" });
      const r = await runProcess(processor, msg2);
      expect(r._tag).toBe("Right");
      if (r._tag === "Right") expect(r.right).toBe(msg2);
    });
  });

  describe("mixed scenarios", () => {
    it("should handle interleaved unique and duplicate messages", async () => {
      const processor = createDedupeProcessor({ key: "id" });
      const results: Array<Message | Message[]> = [];

      const msgs = [
        makeMsg("m1", { id: "A" }), // unique → pass
        makeMsg("m2", { id: "B" }), // unique → pass
        makeMsg("m3", { id: "A" }), // dup → suppress
        makeMsg("m4", { id: "C" }), // unique → pass
        makeMsg("m5", { id: "B" }), // dup → suppress
        makeMsg("m6", { id: "D" }), // unique → pass
        makeMsg("m7", { id: "A" }), // dup → suppress
      ];

      for (const msg of msgs) {
        const r = await runProcess(processor, msg);
        if (r._tag === "Right") results.push(r.right);
      }

      // 4 unique, 3 duplicates
      const passed = results.filter(
        (r) => !Array.isArray(r) || (r as Message[]).length > 0,
      );
      const suppressed = results.filter(
        (r) => Array.isArray(r) && (r as Message[]).length === 0,
      );
      expect(passed.length).toBe(4);
      expect(suppressed.length).toBe(3);

      const metrics = await Effect.runPromise(processor.getMetrics());
      expect(metrics.dedupeMisses).toBe(4);
      expect(metrics.dedupeHits).toBe(3);
    });

    it("should fail with DedupeKeyExtractionError when key cannot be extracted", async () => {
      const processor = createDedupeProcessor({ key: "missing.field" });
      const msg = makeMsg("m1", { other: "data" });

      const r = await runProcess(processor, msg);

      expect(r._tag).toBe("Left");
      if (r._tag === "Left") {
        expect(r.left).toBeInstanceOf(DedupeKeyExtractionError);
        expect(r.left.keyPath).toBe("missing.field");
        expect(r.left.messageId).toBe("m1");
      }
    });

    it("should track extraction failure in metrics", async () => {
      const processor = createDedupeProcessor({ key: "missing" });
      const msg = makeMsg("m1", { other: "data" });

      await runProcess(processor, msg);
      const metrics = await Effect.runPromise(processor.getMetrics());

      expect(metrics.extractionFailures).toBe(1);
      expect(metrics.dedupeMisses).toBe(0);
      expect(metrics.dedupeHits).toBe(0);
    });

    it("should process correctly after extraction failure on different message", async () => {
      const processor = createDedupeProcessor({ key: "id" });
      const bad = makeMsg("bad", { other: "data" }); // missing "id"
      const good1 = makeMsg("g1", { id: "abc" });
      const good2 = makeMsg("g2", { id: "abc" }); // dup

      const rBad = await runProcess(processor, bad);
      const rGood1 = await runProcess(processor, good1);
      const rGood2 = await runProcess(processor, good2);

      expect(rBad._tag).toBe("Left");
      expect(rGood1._tag).toBe("Right");
      if (rGood1._tag === "Right") expect(rGood1.right).toBe(good1);
      expect(rGood2._tag).toBe("Right");
      if (rGood2._tag === "Right") expect(rGood2.right).toEqual([]);

      const metrics = await Effect.runPromise(processor.getMetrics());
      expect(metrics.extractionFailures).toBe(1);
      expect(metrics.dedupeMisses).toBe(1);
      expect(metrics.dedupeHits).toBe(1);
    });
  });
});
