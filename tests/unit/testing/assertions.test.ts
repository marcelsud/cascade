import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import {
  executeAssertions,
  type Assertion,
  type AssertionContext,
} from "../../../src/testing/assertions.js";
import type { Message } from "../../../src/core/types.js";

const msg = (content: unknown): Message => ({
  id: "m1",
  content,
  metadata: {},
  timestamp: 1,
  correlationId: "c1",
});

const run = (assertions: readonly Assertion[], context: AssertionContext) =>
  Effect.runPromise(executeAssertions(assertions, context));

describe("assertion engine boundaries", () => {
  it("uses === so NaN is not equal and +0 equals -0", async () => {
    const nanResults = await run(
      [
        {
          type: "field_value",
          message: 0,
          path: "content.value",
          expected: Number.NaN,
        },
      ],
      {
        outputMessages: [msg({ value: Number.NaN })],
        pipelineSuccess: true,
      },
    );
    expect(nanResults[0]?.passed).toBe(false);

    const zeroResults = await run(
      [
        {
          type: "field_value",
          message: 0,
          path: "content.value",
          expected: 0,
        },
      ],
      {
        outputMessages: [msg({ value: -0 })],
        pipelineSuccess: true,
      },
    );
    expect(zeroResults[0]?.passed).toBe(true);
  });

  it("falls through mixed array/object pairs to Object.keys comparison", async () => {
    const results = await run(
      [
        {
          type: "field_value",
          message: 0,
          path: "content.value",
          expected: [1],
        },
      ],
      {
        outputMessages: [msg({ value: { 0: 1 } })],
        pipelineSuccess: true,
      },
    );
    // Base deepEqual only special-cased both-arrays; mixed pairs used keys.
    // Object.keys([1]) === ["0"] and Object.keys({0:1}) === ["0"], so equal.
    expect(results[0]?.passed).toBe(true);
  });

  it("counts only literal true JSONata results as matches", async () => {
    const truthyNonTrue = await run(
      [
        {
          type: "some_match",
          condition: "content.text",
        },
      ],
      {
        outputMessages: [msg({ text: "hello" })],
        pipelineSuccess: true,
      },
    );
    expect(truthyNonTrue[0]?.passed).toBe(false);

    const literalTrue = await run(
      [
        {
          type: "some_match",
          condition: "content.flag = true",
        },
      ],
      {
        outputMessages: [msg({ flag: true })],
        pipelineSuccess: true,
      },
    );
    expect(literalTrue[0]?.passed).toBe(true);

    const allMatchTruthy = await run(
      [
        {
          type: "all_match",
          condition: "content.count",
        },
      ],
      {
        outputMessages: [msg({ count: 1 }), msg({ count: 2 })],
        pipelineSuccess: true,
      },
    );
    expect(allMatchTruthy[0]?.passed).toBe(false);
  });
});
