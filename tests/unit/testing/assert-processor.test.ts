import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import {
  createAssertProcessor,
  AssertProcessorError,
  AssertProcessorConfigError,
} from "../../../src/testing/assert-processor.js";
import { AssertProcessorConfigError as RootAssertProcessorConfigError } from "../../../src/index.js";
import { createMessage } from "../../../src/core/types.js";

describe("AssertProcessor", () => {
  describe("Field Assertions", () => {
    it("should pass when all required fields exist", async () => {
      const processor = createAssertProcessor({
        hasFields: ["id", "value"],
      });

      const message = createMessage({
        id: "123",
        value: "test",
        extra: "data",
      });

      const result = await Effect.runPromise(processor.process(message));

      expect(result).toEqual(message); // Should pass through unchanged
    });

    it("should fail when required field is missing", async () => {
      const processor = createAssertProcessor({
        hasFields: ["id", "name"],
      });

      const message = createMessage({ id: "123", value: "test" });

      await expect(
        Effect.runPromise(processor.process(message)),
      ).rejects.toThrow("Missing field 'name'");
    });

    it("should support nested field paths", async () => {
      const processor = createAssertProcessor({
        hasFields: ["user.id", "user.name"],
      });

      const message = createMessage({
        user: { id: "123", name: "John" },
      });

      const result = await Effect.runPromise(processor.process(message));

      expect(result).toEqual(message);
    });

    it("should fail on missing nested fields", async () => {
      const processor = createAssertProcessor({
        hasFields: ["user.address.city"],
      });

      const message = createMessage({
        user: { id: "123" },
      });

      await expect(
        Effect.runPromise(processor.process(message)),
      ).rejects.toThrow("Missing field 'user.address.city'");
    });

    it("should check multiple fields", async () => {
      const processor = createAssertProcessor({
        hasFields: ["id", "type", "amount", "user.name"],
      });

      const message = createMessage({
        id: "123",
        type: "order",
        amount: 100,
        user: { name: "John" },
      });

      const result = await Effect.runPromise(processor.process(message));

      expect(result).toEqual(message);
    });
  });

  describe("Condition Assertions", () => {
    it("should pass when condition evaluates to true", async () => {
      const processor = createAssertProcessor({
        condition: "content.amount > 50",
      });

      const message = createMessage({ amount: 100 });

      const result = await Effect.runPromise(processor.process(message));

      expect(result).toEqual(message);
    });

    it("should fail when condition evaluates to false", async () => {
      const processor = createAssertProcessor({
        condition: "content.amount > 50",
      });

      const message = createMessage({ amount: 25 });

      await expect(
        Effect.runPromise(processor.process(message)),
      ).rejects.toThrow("Condition 'content.amount > 50' evaluated to false");
    });

    it("should support complex JSONata expressions", async () => {
      const processor = createAssertProcessor({
        condition: 'content.type = "order" and content.amount > 100',
      });

      const message = createMessage({ type: "order", amount: 150 });

      const result = await Effect.runPromise(processor.process(message));

      expect(result).toEqual(message);
    });

    it("should have access to full message in condition", async () => {
      const processor = createAssertProcessor({
        condition: 'metadata.source = "test-input"',
      });

      const message = createMessage(
        { value: "test" },
        { source: "test-input" },
      );

      const result = await Effect.runPromise(processor.process(message));

      expect(result).toEqual(message);
    });

    it("should fail on invalid JSONata expression", async () => {
      // JSONata throws errors during compilation, not evaluation
      expect(() => {
        createAssertProcessor({
          condition: "invalid[[[",
        });
      }).toThrow();
    });
  });

  describe("Combined Assertions", () => {
    it("should check both fields and condition", async () => {
      const processor = createAssertProcessor({
        hasFields: ["id", "amount"],
        condition: "content.amount > 0",
      });

      const message = createMessage({ id: "123", amount: 50 });

      const result = await Effect.runPromise(processor.process(message));

      expect(result).toEqual(message);
    });

    it("should fail if fields missing even if condition passes", async () => {
      const processor = createAssertProcessor({
        hasFields: ["id", "name"],
        condition: "content.amount > 0",
      });

      const message = createMessage({ id: "123", amount: 50 });

      await expect(
        Effect.runPromise(processor.process(message)),
      ).rejects.toThrow("Missing field 'name'");
    });

    it("should check fields before condition", async () => {
      const processor = createAssertProcessor({
        hasFields: ["id"],
        condition: 'content.id = "123"',
      });

      const message = createMessage({ id: "123" });

      const result = await Effect.runPromise(processor.process(message));

      expect(result).toEqual(message);
    });
  });

  describe("Custom Error Messages", () => {
    it("should use custom error message for field assertions", async () => {
      const processor = createAssertProcessor({
        hasFields: ["id"],
        error: "Custom validation failed",
      });

      const message = createMessage({ value: "test" });

      await expect(
        Effect.runPromise(processor.process(message)),
      ).rejects.toThrow("Custom validation failed");
    });

    it("should use custom error message for condition assertions", async () => {
      const processor = createAssertProcessor({
        condition: "content.amount > 100",
        error: "Amount must be greater than 100",
      });

      const message = createMessage({ amount: 50 });

      await expect(
        Effect.runPromise(processor.process(message)),
      ).rejects.toThrow("Amount must be greater than 100");
    });

    it("should include messageId in error", async () => {
      const processor = createAssertProcessor({
        hasFields: ["id"],
      });

      const message = createMessage({ value: "test" });

      try {
        await Effect.runPromise(processor.process(message));
        expect.fail("Should have thrown error");
      } catch (error: any) {
        expect(error.message).toContain(`messageId: ${message.id}`);
      }
    });
  });

  describe("Pass-Through Behavior", () => {
    it("should not modify message content", async () => {
      const processor = createAssertProcessor({
        hasFields: ["id"],
      });

      const originalContent = {
        id: "123",
        value: "test",
        nested: { data: "example" },
      };
      const message = createMessage(originalContent);

      const result = await Effect.runPromise(processor.process(message));

      expect(result.content).toEqual(originalContent);
      expect(result).toEqual(message);
    });

    it("should preserve message metadata", async () => {
      const processor = createAssertProcessor({
        condition: 'content.value = "test"',
      });

      const message = createMessage(
        { value: "test" },
        { source: "input", custom: "data" },
      );

      const result = await Effect.runPromise(processor.process(message));

      expect(result.metadata).toEqual(message.metadata);
    });

    it("should preserve message ID", async () => {
      const processor = createAssertProcessor({
        hasFields: ["value"],
      });

      const message = createMessage({ value: "test" });
      const result = await Effect.runPromise(processor.process(message));

      expect(result.id).toBe(message.id);
    });
  });

  describe("Vacuous Configuration", () => {
    const vacuousConfigurations = [
      ["undefined config", () => createAssertProcessor()],
      ["empty config", () => createAssertProcessor({})],
      ["empty condition", () => createAssertProcessor({ condition: "" })],
      ["blank condition", () => createAssertProcessor({ condition: "   " })],
      ["empty field list", () => createAssertProcessor({ hasFields: [] })],
      [
        "blank-only field list",
        () => createAssertProcessor({ hasFields: ["   "] }),
      ],
      ["error-only config", () => createAssertProcessor({ error: "x" })],
      [
        "logPassing-only config",
        () => createAssertProcessor({ logPassing: true }),
      ],
    ] as const;

    it.each(vacuousConfigurations)("rejects %s", (_name, create) => {
      expect(create).toThrow(AssertProcessorConfigError);
      expect(create).toThrow(
        "Assert Processor requires at least one effective check: a non-blank 'condition' or at least one non-blank 'hasFields' path.",
      );
    });

    it("names the non-blank hasFields path requirement for blank-only arrays", () => {
      expect(() => createAssertProcessor({ hasFields: ["   "] })).toThrow(
        "Assert Processor requires at least one effective check: a non-blank 'condition' or at least one non-blank 'hasFields' path.",
      );
    });

    it("exports AssertProcessorConfigError from the package root", () => {
      expect(RootAssertProcessorConfigError).toBe(AssertProcessorConfigError);
      expect(() => {
        throw new RootAssertProcessorConfigError("boom");
      }).toThrow(AssertProcessorConfigError);
    });

    it("accepts configurations with an effective check", () => {
      expect(() => createAssertProcessor({ condition: "true" })).not.toThrow();
      expect(() => createAssertProcessor({ hasFields: ["id"] })).not.toThrow();
    });
  });

  describe("Component Properties", () => {
    it("should have correct component name", () => {
      const processor = createAssertProcessor({ condition: "true" });

      expect(processor.name).toBe("assert-processor");
    });

    it("should have process method", () => {
      const processor = createAssertProcessor({ condition: "true" });

      expect(processor.process).toBeDefined();
      expect(typeof processor.process).toBe("function");
    });
  });

  describe("Edge Cases", () => {
    it("should handle null content gracefully", async () => {
      const processor = createAssertProcessor({
        hasFields: ["id"],
      });

      const message = createMessage(null);

      await expect(
        Effect.runPromise(processor.process(message)),
      ).rejects.toThrow();
    });

    it("should handle undefined fields", async () => {
      const processor = createAssertProcessor({
        hasFields: ["value"],
      });

      const message = createMessage({ value: undefined });

      await expect(
        Effect.runPromise(processor.process(message)),
      ).rejects.toThrow("Missing field 'value'");
    });
  });
});
