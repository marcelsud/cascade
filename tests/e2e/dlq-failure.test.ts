import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withDLQ } from "../../src/core/dlq.js";
import { create } from "../../src/core/pipeline.js";
import { createRedisStreamsOutput } from "../../src/outputs/redis-streams-output.js";
import { createSqsOutput } from "../../src/outputs/sqs-output.js";
import { createGenerateInput } from "../../src/testing/generate-input.js";
import {
  E2EResources,
  requireE2EInfrastructure,
  runPipeline,
  SQS_ENDPOINT,
} from "./helpers/index.js";

requireE2EInfrastructure();

describe("DLQ delivery under primary-output failure", () => {
  let resources: E2EResources;

  beforeEach(() => {
    resources = new E2EResources();
  });

  afterEach(async () => {
    await resources.cleanup();
  });

  it("delivers Redis Streams failures to SQS with reason metadata", async () => {
    const count = 2;
    const queue = await resources.createQueue("redis-failure-dlq");
    const primary = createRedisStreamsOutput({
      host: "127.0.0.1",
      port: 1,
      stream: "unreachable",
      maxRetries: 0,
      connectTimeout: 100,
      commandTimeout: 200,
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
    });
    const dlq = createSqsOutput({
      queueUrl: queue.url,
      endpoint: SQS_ENDPOINT,
      maxAttempts: 1,
      maxRetries: 0,
    });

    const result = await runPipeline(
      create({
        name: "redis-streams-to-sqs-dlq",
        input: createGenerateInput({ count, template: { index: "{{index}}" } }),
        processors: [],
        output: withDLQ({ output: primary, dlq, maxRetries: 0 }),
      }),
    );
    const messages = await resources.drainQueue(queue.url, count);
    const metadata = messages.map((message) =>
      JSON.parse(message.MessageAttributes?.metadata?.StringValue ?? "{}"),
    );

    expect(result.success).toBe(true);
    expect(result.metrics?.output?.sendErrors).toBe(count);
    expect(result.metrics?.dlq?.messagesSent).toBe(count);
    expect(messages).toHaveLength(count);
    expect(metadata.every((value) => value.dlq === true)).toBe(true);
    expect(
      metadata.every((value) =>
        value.dlqReason.includes("Failed to send message to Redis stream"),
      ),
    ).toBe(true);
    expect(metadata.every((value) => value.dlqAttempts === 1)).toBe(true);
  }, 20_000);
});
