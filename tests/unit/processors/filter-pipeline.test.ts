import { describe, expect, it } from "vitest";
import { Effect, Stream } from "effect";
import { run } from "../../../src/core/pipeline.js";
import { createMessage } from "../../../src/core/types.js";
import { createFilterProcessor } from "../../../src/processors/filter-processor.js";
import { createCaptureOutput } from "../../../src/testing/capture-output.js";

describe("Filter processor pipeline integration", () => {
  it("skips downstream processing and output but acknowledges a dropped message", async () => {
    let acknowledgements = 0;
    let downstreamCalls = 0;
    const message = {
      ...createMessage({ enabled: false }),
      ack: () =>
        Effect.sync(() => {
          acknowledgements++;
        }),
    };
    const output = await Effect.runPromise(createCaptureOutput());

    const result = await Effect.runPromise(
      run({
        name: "filter-pipeline-test",
        input: { name: "single", stream: Stream.make(message) },
        processors: [
          createFilterProcessor({ check: "enabled" }),
          {
            name: "downstream",
            process: (current) =>
              Effect.sync(() => {
                downstreamCalls++;
                return current;
              }),
          },
        ],
        output,
      }),
    );

    expect(result.success).toBe(true);
    expect(result.stats.processed).toBe(0);
    expect(result.stats.failed).toBe(0);
    expect(await Effect.runPromise(output.getCount())).toBe(0);
    expect(downstreamCalls).toBe(0);
    expect(acknowledgements).toBe(1);
  });
});
