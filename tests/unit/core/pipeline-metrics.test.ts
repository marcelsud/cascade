import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { run } from "../../../src/core/pipeline.js";
import { withDLQ } from "../../../src/core/dlq.js";
import { createHttpOutput } from "../../../src/outputs/http-output.js";
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

  it("surfaces failed HTTP sends and DLQ metrics separately", async () => {
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
          output: createHttpOutput({
            url: "http://127.0.0.1:1/dead",
            timeout: 100,
            maxRetries: 0,
          }),
          dlq,
          maxRetries: 0,
        }),
      }),
    );

    expect(result.success).toBe(true);
    expect(result.metrics?.output).toMatchObject({
      component: "http-output",
      messagesSent: 0,
      sendErrors: 2,
    });
    expect(result.metrics?.dlq).toMatchObject({
      component: "capture-output",
      messagesSent: 2,
      sendErrors: 0,
    });
  });
});
