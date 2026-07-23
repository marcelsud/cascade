import { describe, expect, it } from "vitest";
import { Effect, Logger, LogLevel } from "effect";
import {
  createFilterProcessor,
  FilterError,
} from "../../../src/processors/filter-processor.js";
import { createMessage } from "../../../src/core/types.js";

describe("FilterProcessor", () => {
  it("passes through a message when the check is truthy", async () => {
    const message = createMessage({ status: "active" });
    const processor = createFilterProcessor({
      check: 'status = "active"',
    });

    const result = await Effect.runPromise(processor.process(message));

    expect(result).toBe(message);
  });

  it("suppresses a message when the check is falsy", async () => {
    const message = createMessage({ status: "inactive" });
    const processor = createFilterProcessor({
      check: 'status = "active"',
    });

    const result = await Effect.runPromise(processor.process(message));

    expect(result).toEqual([]);
  });

  it("exposes primitive content as value", async () => {
    const message = createMessage(42);
    const processor = createFilterProcessor({ check: "value > 40" });

    const result = await Effect.runPromise(processor.process(message));

    expect(result).toBe(message);
  });

  it("exposes metadata and message properties as bindings", async () => {
    const message = {
      ...createMessage({ value: 1 }, { source: "api" }),
      id: "message-1",
      correlationId: "correlation-1",
    };
    const processor = createFilterProcessor({
      check:
        '$meta.source = "api" and $message.id = "message-1" and $message.correlationId = "correlation-1"',
    });

    const result = await Effect.runPromise(processor.process(message));

    expect(result).toBe(message);
  });

  it("coerces non-boolean results using truthiness", async () => {
    const message = createMessage({ count: 2 });

    const accepted = await Effect.runPromise(
      createFilterProcessor({ check: "count" }).process(message),
    );
    const dropped = await Effect.runPromise(
      createFilterProcessor({ check: "missing" }).process(message),
    );

    expect(accepted).toBe(message);
    expect(dropped).toEqual([]);
  });

  it("rejects empty and blank checks", () => {
    expect(() => createFilterProcessor({ check: "" })).toThrow(
      /String cannot be empty/,
    );
    expect(() => createFilterProcessor({ check: "   " })).toThrow(
      /check cannot be blank/,
    );
  });

  it("rejects invalid JSONata syntax during construction", () => {
    expect(() => createFilterProcessor({ check: "(" })).toThrow(
      /Failed to compile filter check/,
    );
  });

  it("returns a typed error when evaluation fails", async () => {
    const message = createMessage({ value: 1 });
    const processor = createFilterProcessor({ check: '$error("boom")' });

    const result = await Effect.runPromise(
      Effect.either(processor.process(message)),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(FilterError);
      expect(result.left.message).toContain(message.id);
    }
  });

  it("emits debug decisions without message content", async () => {
    const messages: unknown[] = [];
    const logger = Logger.make<unknown, void>(({ message }) => {
      messages.push(message);
    });
    const content = { secret: "do-not-log" };
    const processor = createFilterProcessor({ check: "true" });
    const message = createMessage(content);

    await Effect.runPromise(
      processor
        .process(message)
        .pipe(
          Logger.withMinimumLogLevel(LogLevel.Debug),
          Effect.provide(Logger.replace(Logger.defaultLogger, logger)),
        ),
    );

    const serialized = JSON.stringify(messages);
    expect(serialized).toContain("Filter accepted");
    expect(serialized).toContain(message.id);
    expect(serialized).not.toContain(content.secret);
  });
});
