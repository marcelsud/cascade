/**
 * E2E tests for dedupe processor proving duplicates do not reach downstream output.
 *
 * These tests exercise the full pipeline path: Input → Dedupe Processor → Output,
 * verifying that duplicate messages (same key) are suppressed before reaching the
 * capture output, while unique messages flow through correctly.
 *
 * This file is intentionally exempt from the infrastructure guard: it is an
 * in-memory pipeline integration test and does not use Redis or LocalStack.
 */
import { describe, it, expect } from "vitest";
import { Effect, Stream } from "effect";
import { createDedupeProcessor } from "../../src/processors/dedupe-processor.js";
import { createCaptureOutput } from "../../src/testing/capture-output.js";
import { createGenerateInput } from "../../src/testing/generate-input.js";
import { create, run } from "../../src/core/pipeline.js";
import { createMessage, type Message } from "../../src/core/types.js";

/**
 * Helper: create a custom input from an array of pre-built messages.
 */
const inputFromMessages = (messages: Message[]) => ({
  name: "test-input",
  stream: Stream.fromIterable(messages),
});

describe("Dedupe Processor E2E — Duplicate Suppression", () => {
  it("should deliver only unique messages to output when duplicates are present (payload key)", async () => {
    // 5 messages: 3 unique orderId values, 2 duplicates
    const messages = [
      createMessage({ orderId: "order-1", data: "first" }),
      createMessage({ orderId: "order-2", data: "second" }),
      createMessage({ orderId: "order-1", data: "dup-of-first" }),
      createMessage({ orderId: "order-3", data: "third" }),
      createMessage({ orderId: "order-2", data: "dup-of-second" }),
    ];

    const input = inputFromMessages(messages);
    const dedupeProcessor = createDedupeProcessor({ key: "orderId" });
    const output = await Effect.runPromise(createCaptureOutput());

    const pipeline = create({
      name: "dedupe-e2e-payload-key",
      input,
      processors: [dedupeProcessor],
      output,
    });

    const result = await Effect.runPromise(run(pipeline));

    const captured = await Effect.runPromise(output.getMessages());

    // Only 3 unique messages should reach the output
    expect(captured).toHaveLength(3);

    // Verify the correct messages passed through (first-seen for each key)
    const capturedOrderIds = captured.map((m: any) => m.content.orderId);
    expect(capturedOrderIds).toEqual(["order-1", "order-2", "order-3"]);

    // Verify first-seen data (not duplicate data)
    expect(captured[0].content.data).toBe("first");
    expect(captured[1].content.data).toBe("second");
    expect(captured[2].content.data).toBe("third");

    // Pipeline stats: 3 processed (sent to output), 2 failed (dedupe extraction → empty array handled)
    // Note: duplicates return [] which results in 0 output sends, not failures
    expect(result.stats.processed).toBe(3);
  });

  it("should deliver only unique messages to output when duplicates use metadata key", async () => {
    const messages = [
      createMessage({ payload: "a" }, { requestId: "req-1" }),
      createMessage({ payload: "b" }, { requestId: "req-2" }),
      createMessage({ payload: "c" }, { requestId: "req-1" }),
      createMessage({ payload: "d" }, { requestId: "req-3" }),
      createMessage({ payload: "e" }, { requestId: "req-2" }),
      createMessage({ payload: "f" }, { requestId: "req-3" }),
    ];

    const input = inputFromMessages(messages);
    const dedupeProcessor = createDedupeProcessor({ key: "metadata.requestId" });
    const output = await Effect.runPromise(createCaptureOutput());

    const pipeline = create({
      name: "dedupe-e2e-metadata-key",
      input,
      processors: [dedupeProcessor],
      output,
    });

    const result = await Effect.runPromise(run(pipeline));

    const captured = await Effect.runPromise(output.getMessages());

    // Only 3 unique requestId values → 3 messages in output
    expect(captured).toHaveLength(3);

    const capturedPayloads = captured.map((m: any) => m.content.payload);
    expect(capturedPayloads).toEqual(["a", "b", "d"]);

    expect(result.stats.processed).toBe(3);
  });

  it("should pass through all messages when every key is unique", async () => {
    const input = createGenerateInput({
      count: 10,
      template: {
        orderId: "order-{{index}}",
        value: "data-{{index}}",
      },
    });

    const dedupeProcessor = createDedupeProcessor({ key: "orderId" });
    const output = await Effect.runPromise(createCaptureOutput());

    const pipeline = create({
      name: "dedupe-e2e-all-unique",
      input,
      processors: [dedupeProcessor],
      output,
    });

    const result = await Effect.runPromise(run(pipeline));

    const captured = await Effect.runPromise(output.getMessages());

    // All 10 messages have unique keys → all should reach output
    expect(captured).toHaveLength(10);
    expect(result.stats.processed).toBe(10);
    expect(result.success).toBe(true);
  });

  it("should suppress all duplicates when all messages share the same key", async () => {
    const messages = Array.from({ length: 5 }, (_, i) =>
      createMessage({ eventId: "same-event", seq: i }),
    );

    const input = inputFromMessages(messages);
    const dedupeProcessor = createDedupeProcessor({ key: "eventId" });
    const output = await Effect.runPromise(createCaptureOutput());

    const pipeline = create({
      name: "dedupe-e2e-all-same-key",
      input,
      processors: [dedupeProcessor],
      output,
    });

    const result = await Effect.runPromise(run(pipeline));

    const captured = await Effect.runPromise(output.getMessages());

    // Only the first message should pass through
    expect(captured).toHaveLength(1);
    expect(captured[0].content.seq).toBe(0);
    expect(result.stats.processed).toBe(1);
  });

  it("should suppress duplicates using nested payload key", async () => {
    const messages = [
      createMessage({ event: { id: "e-1", type: "click" } }),
      createMessage({ event: { id: "e-2", type: "scroll" } }),
      createMessage({ event: { id: "e-1", type: "click-dup" } }),
      createMessage({ event: { id: "e-3", type: "hover" } }),
      createMessage({ event: { id: "e-2", type: "scroll-dup" } }),
    ];

    const input = inputFromMessages(messages);
    const dedupeProcessor = createDedupeProcessor({ key: "event.id" });
    const output = await Effect.runPromise(createCaptureOutput());

    const pipeline = create({
      name: "dedupe-e2e-nested-key",
      input,
      processors: [dedupeProcessor],
      output,
    });

    const result = await Effect.runPromise(run(pipeline));

    const captured = await Effect.runPromise(output.getMessages());

    expect(captured).toHaveLength(3);
    const types = captured.map((m: any) => m.content.event.type);
    expect(types).toEqual(["click", "scroll", "hover"]);
    expect(result.stats.processed).toBe(3);
  });

  it("should count extraction failures when key path is missing from messages", async () => {
    // Mix of valid and invalid messages
    const messages = [
      createMessage({ orderId: "order-1", data: "valid" }),
      createMessage({ noOrderId: "missing-key" }),
      createMessage({ orderId: "order-2", data: "valid" }),
      createMessage({ alsoMissing: true }),
    ];

    const input = inputFromMessages(messages);
    const dedupeProcessor = createDedupeProcessor({ key: "orderId" });
    const output = await Effect.runPromise(createCaptureOutput());

    const pipeline = create({
      name: "dedupe-e2e-extraction-failure",
      input,
      processors: [dedupeProcessor],
      output,
    });

    const result = await Effect.runPromise(run(pipeline));

    const captured = await Effect.runPromise(output.getMessages());

    // Only the 2 valid messages should reach output
    expect(captured).toHaveLength(2);
    const orderIds = captured.map((m: any) => m.content.orderId);
    expect(orderIds).toEqual(["order-1", "order-2"]);

    // 2 extraction failures counted in pipeline stats
    expect(result.stats.failed).toBe(2);
    expect(result.stats.processed).toBe(2);
  });

  it("should work correctly with dedupe processor combined with other processors", async () => {
    // Import uppercase processor for chaining
    const { createUppercaseProcessor } = await import(
      "../../src/processors/uppercase-processor.js"
    );

    const messages = [
      createMessage({ orderId: "order-1", name: "alice" }),
      createMessage({ orderId: "order-2", name: "bob" }),
      createMessage({ orderId: "order-1", name: "alice-dup" }),
      createMessage({ orderId: "order-3", name: "charlie" }),
    ];

    const input = inputFromMessages(messages);
    const dedupeProcessor = createDedupeProcessor({ key: "orderId" });
    const uppercaseProcessor = createUppercaseProcessor({ fields: ["name"] });
    const output = await Effect.runPromise(createCaptureOutput());

    // Dedupe first, then uppercase — duplicates should never reach uppercase or output
    const pipeline = create({
      name: "dedupe-e2e-chained-processors",
      input,
      processors: [dedupeProcessor, uppercaseProcessor],
      output,
    });

    const result = await Effect.runPromise(run(pipeline));

    const captured = await Effect.runPromise(output.getMessages());

    // Only 3 unique messages should reach output
    expect(captured).toHaveLength(3);

    // Names should be uppercased (proving they went through both processors)
    expect(captured[0].content.name).toBe("ALICE");
    expect(captured[1].content.name).toBe("BOB");
    expect(captured[2].content.name).toBe("CHARLIE");

    expect(result.stats.processed).toBe(3);
  });

  it("should deliver zero messages to output when input is empty", async () => {
    const input = inputFromMessages([]);
    const dedupeProcessor = createDedupeProcessor({ key: "orderId" });
    const output = await Effect.runPromise(createCaptureOutput());

    const pipeline = create({
      name: "dedupe-e2e-empty-input",
      input,
      processors: [dedupeProcessor],
      output,
    });

    const result = await Effect.runPromise(run(pipeline));

    const captured = await Effect.runPromise(output.getMessages());

    expect(captured).toHaveLength(0);
    expect(result.stats.processed).toBe(0);
    expect(result.success).toBe(true);
  });

  it("should handle high-volume dedup with correct output count", async () => {
    // 100 messages with only 10 unique keys → heavy dedup pressure
    const messages = Array.from({ length: 100 }, (_, i) =>
      createMessage({
        eventId: `event-${i % 10}`,
        seq: i,
      }),
    );

    const input = inputFromMessages(messages);
    const dedupeProcessor = createDedupeProcessor({ key: "eventId" });
    const output = await Effect.runPromise(createCaptureOutput());

    const pipeline = create({
      name: "dedupe-e2e-high-volume",
      input,
      processors: [dedupeProcessor],
      output,
    });

    const result = await Effect.runPromise(run(pipeline));

    const captured = await Effect.runPromise(output.getMessages());

    // Only 10 unique eventId values → 10 messages in output
    expect(captured).toHaveLength(10);
    expect(result.stats.processed).toBe(10);

    // Verify each unique key appears exactly once
    const eventIds = captured.map((m: any) => m.content.eventId);
    const uniqueEventIds = new Set(eventIds);
    expect(uniqueEventIds.size).toBe(10);

    // Verify first-seen messages (seq 0-9 for event-0 through event-9)
    for (let i = 0; i < 10; i++) {
      const msg = captured.find((m: any) => m.content.eventId === `event-${i}`);
      expect(msg).toBeDefined();
      expect(msg!.content.seq).toBe(i);
    }

    // Verify dedupe metrics
    const metrics = await Effect.runPromise(dedupeProcessor.getMetrics());
    expect(metrics.dedupeMisses).toBe(10);
    expect(metrics.dedupeHits).toBe(90);
  });
});
