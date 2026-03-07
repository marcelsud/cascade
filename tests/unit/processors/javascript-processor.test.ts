import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { createJavaScriptProcessor } from "../../../src/processors/javascript-processor.js";
import { createMessage } from "../../../src/core/types.js";

describe("JavaScriptProcessor", () => {
  it("should transform content with simple code", async () => {
    const processor = createJavaScriptProcessor({
      code: `
        return { name: content.name.toUpperCase(), age: content.age + 1 };
      `,
    });

    const msg = createMessage({ name: "john", age: 30 });
    const result = await Effect.runPromise(processor.process(msg));

    expect(Array.isArray(result) ? result[0].content : result.content).toEqual({
      name: "JOHN",
      age: 31,
    });
  });

  it("should have access to metadata", async () => {
    const processor = createJavaScriptProcessor({
      code: `
        return { source: metadata.source, id: message.id };
      `,
    });

    const msg = createMessage({ value: 1 }, { source: "api" });
    const result = await Effect.runPromise(processor.process(msg));
    const out = Array.isArray(result) ? result[0] : result;

    expect(out.content.source).toBe("api");
    expect(out.content.id).toBe(msg.id);
  });

  it("should support returning arrays for fan-out", async () => {
    const processor = createJavaScriptProcessor({
      code: `
        return content.items.map(function(item) { return { item: item }; });
      `,
    });

    const msg = createMessage({ items: ["a", "b", "c"] });
    const result = await Effect.runPromise(processor.process(msg));

    expect(Array.isArray(result)).toBe(true);
    const results = result as any[];
    expect(results).toHaveLength(3);
    expect(results[0].content).toEqual({ item: "a" });
    expect(results[1].content).toEqual({ item: "b" });
    expect(results[2].content).toEqual({ item: "c" });
    expect(results[0].metadata.fanOutIndex).toBe(0);
  });

  it("should add javascriptProcessed metadata", async () => {
    const processor = createJavaScriptProcessor({
      code: `return content;`,
    });

    const msg = createMessage({ value: 42 });
    const result = await Effect.runPromise(processor.process(msg));
    const out = Array.isArray(result) ? result[0] : result;

    expect(out.metadata.javascriptProcessed).toBe(true);
  });

  it("should handle computation logic", async () => {
    const processor = createJavaScriptProcessor({
      code: `
        var total = 0;
        for (var i = 0; i < content.prices.length; i++) {
          total += content.prices[i];
        }
        return { total: total, count: content.prices.length, avg: total / content.prices.length };
      `,
    });

    const msg = createMessage({ prices: [10, 20, 30, 40] });
    const result = await Effect.runPromise(processor.process(msg));
    const out = Array.isArray(result) ? result[0] : result;

    expect(out.content.total).toBe(100);
    expect(out.content.count).toBe(4);
    expect(out.content.avg).toBe(25);
  });

  it("should fail on syntax errors", async () => {
    const processor = createJavaScriptProcessor({
      code: `return {{{invalid`,
    });

    const msg = createMessage({ value: 1 });
    const result = await Effect.runPromiseExit(processor.process(msg));

    expect(result._tag).toBe("Failure");
  });

  it("should fail on runtime errors", async () => {
    const processor = createJavaScriptProcessor({
      code: `
        var x = null;
        return x.foo.bar;
      `,
    });

    const msg = createMessage({ value: 1 });
    const result = await Effect.runPromiseExit(processor.process(msg));

    expect(result._tag).toBe("Failure");
  });

  it("should timeout on infinite loops", async () => {
    const processor = createJavaScriptProcessor({
      code: `while(true) {}; return content;`,
      timeout_ms: 200,
    });

    const msg = createMessage({ value: 1 });
    const result = await Effect.runPromiseExit(processor.process(msg));

    expect(result._tag).toBe("Failure");
  }, 10000);

  it("should not have access to dangerous globals", async () => {
    // QuickJS WASM has no process, require, fs, etc. by design
    // Accessing them should return undefined or throw
    const processor = createJavaScriptProcessor({
      code: `
        return {
          hasProcess: typeof process !== 'undefined',
          hasRequire: typeof require !== 'undefined',
          hasGlobalThis: typeof globalThis !== 'undefined',
        };
      `,
    });

    const msg = createMessage({});
    const result = await Effect.runPromise(processor.process(msg));
    const out = Array.isArray(result) ? result[0] : result;

    expect(out.content.hasProcess).toBe(false);
    expect(out.content.hasRequire).toBe(false);
  });

  it("should handle string content", async () => {
    const processor = createJavaScriptProcessor({
      code: `return content.toUpperCase();`,
    });

    const msg = createMessage("hello world");
    const result = await Effect.runPromise(processor.process(msg));
    const out = Array.isArray(result) ? result[0] : result;

    expect(out.content).toBe("HELLO WORLD");
  });

  it("should preserve message identity", async () => {
    const processor = createJavaScriptProcessor({
      code: `return { transformed: true };`,
    });

    const msg = createMessage({ original: true }, { key: "value" });
    const result = await Effect.runPromise(processor.process(msg));
    const out = Array.isArray(result) ? result[0] : result;

    expect(out.id).toBe(msg.id);
    expect(out.timestamp).toBe(msg.timestamp);
    expect(out.metadata.key).toBe("value");
  });
});
