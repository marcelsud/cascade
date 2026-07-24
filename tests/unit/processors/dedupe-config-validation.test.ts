import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import * as S from "effect/Schema";
import { PipelineConfigSchema } from "../../../src/core/config-loader.js";

/**
 * Helper: build a minimal pipeline config with a dedupe processor.
 * Wraps the given dedupe config in a valid pipeline structure.
 */
const withDedupeProcessor = (dedupeConfig: Record<string, unknown>) => ({
  input: { generate: { count: 1, template: { value: "test" } } },
  pipeline: { processors: [{ dedupe: dedupeConfig }] },
  output: { capture: {} },
});

/**
 * Helper: attempt schema decode and return success/failure.
 */
const decodeConfig = (raw: unknown) =>
  Effect.runSync(Effect.either(S.decodeUnknown(PipelineConfigSchema)(raw)));

describe("Dedupe Processor Config Validation", () => {
  describe("valid configurations", () => {
    it("should accept minimal config with only required key", () => {
      const result = decodeConfig(withDedupeProcessor({ key: "messageId" }));
      expect(result._tag).toBe("Right");
    });

    it("should accept config with all optional fields", () => {
      const result = decodeConfig(
        withDedupeProcessor({
          key: "metadata.correlationId",
          window_ms: 30000,
          max_keys: 5000,
        }),
      );
      expect(result._tag).toBe("Right");
    });

    it("should accept payload dot-path key", () => {
      const result = decodeConfig(
        withDedupeProcessor({ key: "data.event.id" }),
      );
      expect(result._tag).toBe("Right");
    });

    it("should accept metadata key", () => {
      const result = decodeConfig(
        withDedupeProcessor({ key: "metadata.requestId" }),
      );
      expect(result._tag).toBe("Right");
    });

    it("should accept window_ms without max_keys", () => {
      const result = decodeConfig(
        withDedupeProcessor({ key: "id", window_ms: 120000 }),
      );
      expect(result._tag).toBe("Right");
    });

    it("should accept max_keys without window_ms", () => {
      const result = decodeConfig(
        withDedupeProcessor({ key: "id", max_keys: 500 }),
      );
      expect(result._tag).toBe("Right");
    });
  });

  describe("missing required fields", () => {
    it("should reject config without key", () => {
      const result = decodeConfig(withDedupeProcessor({}));
      expect(result._tag).toBe("Left");
    });

    it("should reject empty key string", () => {
      const result = decodeConfig(withDedupeProcessor({ key: "" }));
      expect(result._tag).toBe("Left");
    });
  });

  describe("invalid key values", () => {
    it("should reject key as number", () => {
      const result = decodeConfig(withDedupeProcessor({ key: 123 }));
      expect(result._tag).toBe("Left");
    });

    it("should reject key as boolean", () => {
      const result = decodeConfig(withDedupeProcessor({ key: true }));
      expect(result._tag).toBe("Left");
    });

    it("should reject key as null", () => {
      const result = decodeConfig(withDedupeProcessor({ key: null }));
      expect(result._tag).toBe("Left");
    });

    it("should reject key as array", () => {
      const result = decodeConfig(
        withDedupeProcessor({ key: ["field1", "field2"] }),
      );
      expect(result._tag).toBe("Left");
    });
  });

  describe("invalid window_ms values", () => {
    it("should reject window_ms of zero", () => {
      const result = decodeConfig(
        withDedupeProcessor({ key: "id", window_ms: 0 }),
      );
      expect(result._tag).toBe("Left");
    });

    it("should reject negative window_ms", () => {
      const result = decodeConfig(
        withDedupeProcessor({ key: "id", window_ms: -1000 }),
      );
      expect(result._tag).toBe("Left");
    });

    it("should reject window_ms as string", () => {
      const result = decodeConfig(
        withDedupeProcessor({ key: "id", window_ms: "30000" }),
      );
      expect(result._tag).toBe("Left");
    });
  });

  describe("invalid max_keys values", () => {
    it("should reject max_keys of zero", () => {
      const result = decodeConfig(
        withDedupeProcessor({ key: "id", max_keys: 0 }),
      );
      expect(result._tag).toBe("Left");
    });

    it("should reject negative max_keys", () => {
      const result = decodeConfig(
        withDedupeProcessor({ key: "id", max_keys: -10 }),
      );
      expect(result._tag).toBe("Left");
    });

    it("should reject fractional max_keys", () => {
      const result = decodeConfig(
        withDedupeProcessor({ key: "id", max_keys: 100.5 }),
      );
      expect(result._tag).toBe("Left");
    });

    it("should reject max_keys as string", () => {
      const result = decodeConfig(
        withDedupeProcessor({ key: "id", max_keys: "500" }),
      );
      expect(result._tag).toBe("Left");
    });
  });

  describe("combined invalid fields", () => {
    it("should reject when both optional fields are invalid", () => {
      const result = decodeConfig(
        withDedupeProcessor({ key: "id", window_ms: -1, max_keys: 0 }),
      );
      expect(result._tag).toBe("Left");
    });

    it("should reject when key is empty and optional fields are valid", () => {
      const result = decodeConfig(
        withDedupeProcessor({ key: "", window_ms: 5000, max_keys: 100 }),
      );
      expect(result._tag).toBe("Left");
    });
  });

  describe("unknown/extra fields", () => {
    it("should accept config with unknown extra fields (schema strips them)", () => {
      const result = decodeConfig(
        withDedupeProcessor({
          key: "messageId",
          unknown_option: "value",
        }),
      );
      // Effect Schema by default allows excess properties at decode
      expect(result._tag).toBe("Right");
    });
  });
});
