import { describe, it, expect } from "vitest";
import { extractKey } from "../../../src/processors/dedupe-processor.js";
import { createMessage } from "../../../src/core/types.js";

describe("Dedupe Key Extraction", () => {
  describe("payload attribute paths", () => {
    it("should extract top-level payload field", () => {
      const msg = createMessage({ orderId: "abc-123", value: 42 });
      expect(extractKey("orderId", msg)).toBe("abc-123");
    });

    it("should extract nested payload field via dot-path", () => {
      const msg = createMessage({
        data: { event: { id: "evt-456" } },
      });
      expect(extractKey("data.event.id", msg)).toBe("evt-456");
    });

    it("should extract deeply nested payload field", () => {
      const msg = createMessage({
        a: { b: { c: { d: "deep-value" } } },
      });
      expect(extractKey("a.b.c.d", msg)).toBe("deep-value");
    });

    it("should return undefined for non-existent payload path", () => {
      const msg = createMessage({ orderId: "abc-123" });
      expect(extractKey("nonExistent", msg)).toBeUndefined();
    });

    it("should return undefined for partially valid nested path", () => {
      const msg = createMessage({ data: { event: {} } });
      expect(extractKey("data.event.id", msg)).toBeUndefined();
    });

    it("should return undefined for path through non-object value", () => {
      const msg = createMessage({ data: "string-value" });
      expect(extractKey("data.nested.field", msg)).toBeUndefined();
    });

    it("should return undefined when payload field is null", () => {
      const msg = createMessage({ orderId: null });
      expect(extractKey("orderId", msg)).toBeUndefined();
    });

    it("should return undefined when payload field is undefined", () => {
      const msg = createMessage({ orderId: undefined });
      expect(extractKey("orderId", msg)).toBeUndefined();
    });

    it("should stringify numeric payload values", () => {
      const msg = createMessage({ count: 42 });
      expect(extractKey("count", msg)).toBe("42");
    });

    it("should stringify boolean payload values", () => {
      const msg = createMessage({ active: true });
      expect(extractKey("active", msg)).toBe("true");
    });

    it("should stringify zero as '0'", () => {
      const msg = createMessage({ index: 0 });
      expect(extractKey("index", msg)).toBe("0");
    });

    it("should stringify false as 'false'", () => {
      const msg = createMessage({ flag: false });
      expect(extractKey("flag", msg)).toBe("false");
    });

    it("should return undefined when content is a string (non-object)", () => {
      const msg = createMessage("plain-text");
      expect(extractKey("field", msg)).toBeUndefined();
    });

    it("should return undefined when content is null", () => {
      const msg = createMessage(null);
      expect(extractKey("field", msg)).toBeUndefined();
    });

    it("should return undefined when content is an array", () => {
      const msg = createMessage([1, 2, 3]);
      expect(extractKey("0", msg)).toBeUndefined();
    });

    it("should extract empty string value as ''", () => {
      const msg = createMessage({ key: "" });
      expect(extractKey("key", msg)).toBe("");
    });
  });

  describe("metadata attribute paths", () => {
    it("should extract top-level metadata field", () => {
      const msg = createMessage({ value: "payload" }, { requestId: "req-789" });
      expect(extractKey("metadata.requestId", msg)).toBe("req-789");
    });

    it("should extract nested metadata field via dot-path", () => {
      const msg = createMessage(
        { value: "payload" },
        { headers: { contentType: "application/json" } },
      );
      expect(extractKey("metadata.headers.contentType", msg)).toBe(
        "application/json",
      );
    });

    it("should extract deeply nested metadata field", () => {
      const msg = createMessage(
        { value: "payload" },
        { trace: { span: { id: "span-001" } } },
      );
      expect(extractKey("metadata.trace.span.id", msg)).toBe("span-001");
    });

    it("should return undefined for non-existent metadata field", () => {
      const msg = createMessage({ value: "payload" }, { requestId: "req-789" });
      expect(extractKey("metadata.nonExistent", msg)).toBeUndefined();
    });

    it("should return undefined for partially valid nested metadata path", () => {
      const msg = createMessage({ value: "payload" }, { headers: {} });
      expect(extractKey("metadata.headers.contentType", msg)).toBeUndefined();
    });

    it("should return undefined when metadata field is null", () => {
      const msg = createMessage({ value: "payload" }, { requestId: null });
      expect(extractKey("metadata.requestId", msg)).toBeUndefined();
    });

    it("should stringify numeric metadata values", () => {
      const msg = createMessage({ value: "payload" }, { retryCount: 3 });
      expect(extractKey("metadata.retryCount", msg)).toBe("3");
    });

    it("should stringify boolean metadata values", () => {
      const msg = createMessage({ value: "payload" }, { isRetry: true });
      expect(extractKey("metadata.isRetry", msg)).toBe("true");
    });

    it("should return undefined for bare 'metadata.' with no field name", () => {
      const msg = createMessage({ value: "payload" }, { anything: "value" });
      expect(extractKey("metadata.", msg)).toBeUndefined();
    });

    it("should extract empty string metadata value as ''", () => {
      const msg = createMessage({ value: "payload" }, { tag: "" });
      expect(extractKey("metadata.tag", msg)).toBe("");
    });
  });

  describe("key path prefix disambiguation", () => {
    it("should prefer metadata when key starts with 'metadata.'", () => {
      const msg = createMessage(
        { metadata: { field: "from-payload" } },
        { field: "from-metadata" },
      );
      expect(extractKey("metadata.field", msg)).toBe("from-metadata");
    });

    it("should use payload path for keys not starting with 'metadata.'", () => {
      const msg = createMessage(
        { meta: { field: "from-payload-meta" } },
        { field: "from-metadata" },
      );
      expect(extractKey("meta.field", msg)).toBe("from-payload-meta");
    });

    it("should resolve payload key named 'metadata' (without dot) from payload", () => {
      const msg = createMessage(
        { metadata: "payload-level-metadata" },
        { something: "meta-value" },
      );
      // "metadata" (no dot) is a payload path, not a metadata prefix
      expect(extractKey("metadata", msg)).toBe("payload-level-metadata");
    });
  });

  describe("edge cases", () => {
    it("should handle message with empty metadata object", () => {
      const msg = createMessage({ orderId: "abc" }, {});
      expect(extractKey("metadata.anyField", msg)).toBeUndefined();
      expect(extractKey("orderId", msg)).toBe("abc");
    });

    it("should handle message with empty payload object", () => {
      const msg = createMessage({}, { requestId: "req-1" });
      expect(extractKey("orderId", msg)).toBeUndefined();
      expect(extractKey("metadata.requestId", msg)).toBe("req-1");
    });

    it("should handle payload field that is an object (stringify)", () => {
      const msg = createMessage({ nested: { a: 1 } });
      const result = extractKey("nested", msg);
      expect(result).toBe("[object Object]");
    });

    it("should handle payload field that is an array (stringify)", () => {
      const msg = createMessage({ tags: ["a", "b"] });
      const result = extractKey("tags", msg);
      expect(result).toBe("a,b");
    });
  });
});
