import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { create } from "../../src/core/pipeline.js";
import { createSqsOutput } from "../../src/outputs/sqs-output.js";
import { createGenerateInput } from "../../src/testing/generate-input.js";
import { E2EResources, runPipeline, SQS_ENDPOINT } from "./helpers/index.js";

describe("E2E harness", () => {
  let resources: E2EResources;

  beforeEach(() => {
    resources = new E2EResources();
  });

  afterEach(async () => {
    await resources.cleanup();
  });

  it("delivers generated messages to a unique LocalStack SQS queue", async () => {
    const count = 3;
    const queue = await resources.createQueue("foundation-smoke");
    const result = await runPipeline(
      create({
        name: "e2e-harness-smoke",
        input: createGenerateInput({
          count,
          template: { index: "{{index}}" },
        }),
        processors: [],
        output: createSqsOutput({
          queueUrl: queue.url,
          endpoint: SQS_ENDPOINT,
          maxAttempts: 1,
          maxRetries: 0,
        }),
      }),
    );

    const messages = await resources.drainQueue(queue.url, count);

    expect(result.success).toBe(true);
    expect(result.stats.processed).toBe(count);
    expect(
      messages.map((message) => JSON.parse(message.Body ?? "{}").index).sort(),
    ).toEqual(["0", "1", "2"]);
  });
});
