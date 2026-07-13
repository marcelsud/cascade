import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { run } from "../../../src/core/pipeline.js";
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
});
