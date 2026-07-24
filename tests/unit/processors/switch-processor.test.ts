import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { createSwitchProcessor } from "../../../src/processors/switch-processor.js";
import { createMetadataProcessor } from "../../../src/processors/metadata-processor.js";
import { createMappingProcessor } from "../../../src/processors/mapping-processor.js";
import {
  createMessage,
  type Message,
  type Processor,
} from "../../../src/core/types.js";

describe("SwitchProcessor", () => {
  it("should execute the first matching case", async () => {
    const message = createMessage({ type: "order", amount: 100 });

    const switchProcessor = createSwitchProcessor({
      cases: [
        {
          check: 'type = "order"',
          processors: [createMetadataProcessor({ addTimestamp: true })],
        },
        {
          check: 'type = "refund"',
          processors: [createMetadataProcessor({ addTimestamp: false })],
        },
      ],
    });

    const result = await Effect.runPromise(switchProcessor.process(message));

    // First case should match
    expect(result.metadata.processedBy).toBe("metadata-processor");
    expect(result.metadata.processedAt).toBeDefined();
  });

  it("should return message unchanged if no case matches", async () => {
    const message = createMessage({ type: "unknown", amount: 100 });

    const switchProcessor = createSwitchProcessor({
      cases: [
        {
          check: 'type = "order"',
          processors: [createMetadataProcessor()],
        },
        {
          check: 'type = "refund"',
          processors: [createMetadataProcessor()],
        },
      ],
    });

    const result = await Effect.runPromise(switchProcessor.process(message));

    // No case matched, message should be unchanged
    expect(result).toEqual(message);
  });

  it("should stop at first matching case (no fallthrough)", async () => {
    const message = createMessage({ priority: 1 });

    let counter = 0;
    const incrementProcessor = {
      name: "increment",
      process: (msg: any) =>
        Effect.sync(() => {
          counter++;
          return msg;
        }),
    };

    const switchProcessor = createSwitchProcessor({
      cases: [
        {
          check: "priority > 0",
          processors: [incrementProcessor],
        },
        {
          check: "priority > -100", // Also matches, but should not execute
          processors: [incrementProcessor],
        },
      ],
    });

    await Effect.runPromise(switchProcessor.process(message));

    // Only first case should execute
    expect(counter).toBe(1);
  });

  it("should run multiple processors in a matching case", async () => {
    const message = createMessage({ type: "urgent", value: 10 });

    const switchProcessor = createSwitchProcessor({
      cases: [
        {
          check: 'type = "urgent"',
          processors: [
            createMetadataProcessor(),
            createMappingProcessor({ expression: "$" }),
          ],
        },
      ],
    });

    const result = await Effect.runPromise(switchProcessor.process(message));

    // Both processors should have run
    expect(result.metadata.processedBy).toBe("metadata-processor");
    expect(result.metadata.mappingApplied).toBe(true);
  });

  it("should support complex JSONata expressions", async () => {
    const message = createMessage({ amount: 150, priority: "high" });

    const switchProcessor = createSwitchProcessor({
      cases: [
        {
          check: "amount < 100",
          processors: [createMetadataProcessor({ addTimestamp: false })],
        },
        {
          check: 'amount >= 100 and priority = "high"',
          processors: [createMetadataProcessor({ addTimestamp: true })],
        },
      ],
    });

    const result = await Effect.runPromise(switchProcessor.process(message));

    // Second case should match (amount >= 100 AND priority = "high")
    expect(result.metadata.processedAt).toBeDefined();
  });

  it("should access message metadata in check expressions", async () => {
    const message = createMessage({ value: 1 }, { source: "external-api" });

    const switchProcessor = createSwitchProcessor({
      cases: [
        {
          check: '$meta.source = "external-api"',
          processors: [createMetadataProcessor()],
        },
      ],
    });

    const result = await Effect.runPromise(switchProcessor.process(message));

    // Case should match based on metadata
    expect(result.metadata.processedBy).toBe("metadata-processor");
  });

  it("should propagate an empty result from a matching case", async () => {
    const message = createMessage({ enabled: false });
    const suppress = {
      name: "suppress",
      process: () => Effect.succeed([]),
    };
    const switchProcessor = createSwitchProcessor({
      cases: [{ check: "true", processors: [suppress] }],
    });

    const result = await Effect.runPromise(switchProcessor.process(message));

    expect(result).toEqual([]);
  });

  it("should propagate multiple results through remaining case processors", async () => {
    const message = createMessage({ value: 1 });
    const split = {
      name: "split",
      process: (msg: any) =>
        Effect.succeed([
          { ...msg, content: { value: 2 } },
          { ...msg, content: { value: 3 } },
        ]),
    };
    const mark = {
      name: "mark",
      process: (msg: any) =>
        Effect.succeed({ ...msg, metadata: { ...msg.metadata, marked: true } }),
    };
    const switchProcessor = createSwitchProcessor({
      cases: [{ check: "true", processors: [split, mark] }],
    });

    const result = await Effect.runPromise(switchProcessor.process(message));

    expect(result).toHaveLength(2);
    expect(result.map((item: any) => item.content.value)).toEqual([2, 3]);
    expect(result.every((item: any) => item.metadata.marked)).toBe(true);
  });

  it("should coerce non-boolean results to boolean", async () => {
    const message = createMessage({ count: 5 });

    const switchProcessor = createSwitchProcessor({
      cases: [
        {
          check: "count", // Truthy value (5) should be coerced to true
          processors: [createMetadataProcessor()],
        },
      ],
    });

    const result = await Effect.runPromise(switchProcessor.process(message));

    // Case should match (5 is truthy)
    expect(result.metadata.processedBy).toBe("metadata-processor");
  });

  it("should route using only each message's own bindings under concurrency", async () => {
    const routeByBindings: Processor = {
      name: "route-by-bindings",
      process: (msg: Message) => {
        const content =
          typeof msg.content === "object" && msg.content !== null
            ? (msg.content as Record<string, unknown>)
            : {};

        return Effect.succeed({
          ...msg,
          content: {
            ...content,
            routedByMessageId: msg.id,
            routedBySource: msg.metadata.source,
            routedByLane: content.lane,
          },
        });
      },
    };

    const switchProcessor = createSwitchProcessor({
      cases: [
        {
          // Match only when content lane, $message.id, and $meta.source all agree.
          // Cross-wired bindings would route to the wrong case or fail both checks.
          check:
            'lane = "alpha" and $message.id = expectedMessageId and $meta.source = expectedSource',
          processors: [
            createMappingProcessor({
              expression: `{
                "lane": "alpha",
                "workerId": workerId,
                "boundMessageId": $message.id,
                "boundSource": $meta.source,
                "route": "alpha"
              }`,
            }),
            routeByBindings,
          ],
        },
        {
          check:
            'lane = "beta" and $message.id = expectedMessageId and $meta.source = expectedSource',
          processors: [
            createMappingProcessor({
              expression: `{
                "lane": "beta",
                "workerId": workerId,
                "boundMessageId": $message.id,
                "boundSource": $meta.source,
                "route": "beta"
              }`,
            }),
            routeByBindings,
          ],
        },
      ],
    });

    const messages = Array.from({ length: 40 }, (_, index) => {
      const lane = index % 2 === 0 ? "alpha" : "beta";
      const message = createMessage(
        {
          lane,
          workerId: index,
          expectedMessageId: "pending",
          expectedSource: `source-${index}`,
        },
        { source: `source-${index}` },
      );

      return {
        ...message,
        content: {
          ...message.content,
          expectedMessageId: message.id,
        },
      };
    });

    const results = await Effect.runPromise(
      Effect.forEach(messages, (message) => switchProcessor.process(message), {
        concurrency: 10,
      }),
    );

    expect(results).toHaveLength(messages.length);

    for (let index = 0; index < messages.length; index++) {
      const source = messages[index];
      const result = results[index] as Message<Record<string, unknown>>;
      const expectedLane = index % 2 === 0 ? "alpha" : "beta";

      expect(result.id).toBe(source.id);
      expect(result.content.workerId).toBe(index);
      expect(result.content.lane).toBe(expectedLane);
      expect(result.content.route).toBe(expectedLane);
      expect(result.content.boundMessageId).toBe(source.id);
      expect(result.content.boundSource).toBe(`source-${index}`);
      expect(result.content.routedByMessageId).toBe(source.id);
      expect(result.content.routedBySource).toBe(`source-${index}`);
      expect(result.content.routedByLane).toBe(expectedLane);
    }
  });
});
