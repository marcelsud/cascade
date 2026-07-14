import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { run } from "../../../src/core/pipeline.js";
import { withDLQ } from "../../../src/core/dlq.js";
import { createGenerateInput } from "../../../src/testing/generate-input.js";
import { createCaptureOutput } from "../../../src/testing/capture-output.js";

describe("PipelineResult metrics", () => {
  it("surfaces generate input and capture output snapshots", async () => {
    const output = await Effect.runPromise(createCaptureOutput());
    const result = await Effect.runPromise(
      run({
        name: "metrics-test",
        input: createGenerateInput({
          count: 3,
          template: { value: "{{index}}" },
        }),
        processors: [],
        output,
      }),
    );

    expect(result.success).toBe(true);
    expect(result.metrics?.input).toMatchObject({
      component: "generate-input",
      messagesProcessed: 3,
      messagesDropped: 0,
      errorsEncountered: 0,
    });
    expect(result.metrics?.output).toMatchObject({
      component: "capture-output",
      messagesSent: 3,
      sendErrors: 0,
    });
  });

  it("surfaces DLQ destination metrics separately from the primary output", async () => {
    const dlq = await Effect.runPromise(createCaptureOutput());
    const result = await Effect.runPromise(
      run({
        name: "dlq-metrics-test",
        input: createGenerateInput({
          count: 2,
          template: { value: "{{index}}" },
        }),
        processors: [],
        output: withDLQ({
          output: {
            name: "failing-output",
            send: () => Effect.fail("primary failed"),
          },
          dlq,
          maxRetries: 0,
        }),
      }),
    );

    expect(result.success).toBe(true);
    expect(result.metrics?.output).toBeUndefined();
    expect(result.metrics?.dlq).toMatchObject({
      component: "capture-output",
      messagesSent: 2,
      sendErrors: 0,
    });
  });
});
