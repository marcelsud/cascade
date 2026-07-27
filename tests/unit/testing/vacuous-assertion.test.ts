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

describe("field_value vacuous expected", () => {
  it("does not pass when expected is omitted/undefined", async () => {
    const results = await run(
      [
        {
          type: "field_value",
          message: 0,
          path: "content.missing",
          expected: undefined,
        },
      ],
      {
        outputMessages: [msg({})],
        pipelineSuccess: true,
      },
    );

    expect(results[0]?.passed).toBe(false);
    expect(results[0]?.message).toMatch(/field_value/i);
    expect(results[0]?.message).toMatch(/no expected value was supplied/i);
  });

  it("still compares explicit null expected values", async () => {
    const nullMatch = await run(
      [
        {
          type: "field_value",
          message: 0,
          path: "content.value",
          expected: null,
        },
      ],
      {
        outputMessages: [msg({ value: null })],
        pipelineSuccess: true,
      },
    );
    expect(nullMatch[0]?.passed).toBe(true);

    const nullMismatch = await run(
      [
        {
          type: "field_value",
          message: 0,
          path: "content.value",
          expected: null,
        },
      ],
      {
        outputMessages: [msg({ value: "not-null" })],
        pipelineSuccess: true,
      },
    );
    expect(nullMismatch[0]?.passed).toBe(false);
  });

  it("fails missing path when expected is supplied", async () => {
    const results = await run(
      [
        {
          type: "field_value",
          message: 0,
          path: "content.missing",
          expected: "present",
        },
      ],
      {
        outputMessages: [msg({})],
        pipelineSuccess: true,
      },
    );

    expect(results[0]?.passed).toBe(false);
    expect(results[0]?.message).toMatch(/Expected content\.missing/i);
  });

  it("leaves field_exists behavior unchanged", async () => {
    const exists = await run(
      [
        {
          type: "field_exists",
          message: 0,
          path: "content.value",
        },
      ],
      {
        outputMessages: [msg({ value: undefined })],
        pipelineSuccess: true,
      },
    );
    // getNestedValue returns undefined for present key with undefined value
    // and for missing keys; field_exists treats both as absent.
    expect(exists[0]?.passed).toBe(false);

    const present = await run(
      [
        {
          type: "field_exists",
          message: 0,
          path: "content.value",
        },
      ],
      {
        outputMessages: [msg({ value: null })],
        pipelineSuccess: true,
      },
    );
    expect(present[0]?.passed).toBe(true);

    const missing = await run(
      [
        {
          type: "field_exists",
          message: 0,
          path: "content.missing",
        },
      ],
      {
        outputMessages: [msg({})],
        pipelineSuccess: true,
      },
    );
    expect(missing[0]?.passed).toBe(false);
  });
});
