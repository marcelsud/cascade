import {
  GetQueueAttributesCommand,
  SendMessageCommand,
} from "@aws-sdk/client-sqs";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { create } from "../../src/core/pipeline.js";
import { createSqsInput } from "../../src/inputs/sqs-input.js";
import { createHttpOutput } from "../../src/outputs/http-output.js";
import {
  createCaptureOutput,
  type CaptureOutput,
} from "../../src/testing/capture-output.js";
import {
  E2EResources,
  requireE2EInfrastructure,
  type RunningPipeline,
  SQS_ENDPOINT,
  startPipeline,
  waitFor,
} from "./helpers/index.js";

requireE2EInfrastructure();

describe("SQS at-least-once delivery", () => {
  let resources: E2EResources;
  let activeRun: RunningPipeline | undefined;

  beforeEach(() => {
    resources = new E2EResources();
  });

  afterEach(async () => {
    if (activeRun) {
      await Effect.runPromise(activeRun.shutdown.requestForce);
      await activeRun.result;
    }
    await resources.cleanup();
  });

  const queueCounts = async (queueUrl: string) => {
    const response = await resources.sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: [
          "ApproximateNumberOfMessages",
          "ApproximateNumberOfMessagesNotVisible",
        ],
      }),
    );
    return {
      visible: Number(response.Attributes?.ApproximateNumberOfMessages ?? 0),
      inFlight: Number(
        response.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0,
      ),
    };
  };

  const sqsInput = (queueUrl: string) =>
    createSqsInput({
      queueUrl,
      endpoint: SQS_ENDPOINT,
      waitTimeSeconds: 1,
      maxMessages: 10,
      maxAttempts: 1,
      requestTimeout: 2_000,
    });

  it("redelivers failed messages and acknowledges successful delivery", async () => {
    const count = 3;
    const queue = await resources.createQueue("sqs-at-least-once", {
      VisibilityTimeout: "1",
    });
    const ids = Array.from({ length: count }, (_, index) => `message-${index}`);
    await Promise.all(
      ids.map((id) =>
        resources.sqs.send(
          new SendMessageCommand({
            QueueUrl: queue.url,
            MessageBody: JSON.stringify({ id }),
          }),
        ),
      ),
    );

    const failingOutput = createHttpOutput({
      url: "http://127.0.0.1:1/dead",
      timeout: 100,
      maxRetries: 0,
    });
    const failedRun = await startPipeline(
      create({
        name: "sqs-failed-delivery",
        input: sqsInput(queue.url),
        processors: [],
        output: failingOutput,
      }),
    );
    activeRun = failedRun;
    await waitFor(
      () => (failingOutput.getMetrics?.().sendErrors ?? 0) >= count,
      `${count} failed output sends`,
    );
    await Effect.runPromise(failedRun.shutdown.request);
    const failedResult = await failedRun.result;
    activeRun = undefined;

    expect(failedResult.success).toBe(false);
    await waitFor(
      async () => (await queueCounts(queue.url)).visible === count,
      "failed SQS messages to become visible again",
    );

    const capture: CaptureOutput = await Effect.runPromise(
      createCaptureOutput(),
    );
    const healthyRun = await startPipeline(
      create({
        name: "sqs-successful-redelivery",
        input: sqsInput(queue.url),
        processors: [],
        output: capture,
      }),
    );
    activeRun = healthyRun;
    await waitFor(
      async () =>
        new Set(
          (await Effect.runPromise(capture.getMessages())).map(
            (message) => message.content.id,
          ),
        ).size >= count,
      `${count} successful redeliveries`,
    );
    await Effect.runPromise(healthyRun.shutdown.request);
    const healthyResult = await healthyRun.result;
    activeRun = undefined;

    const delivered = await Effect.runPromise(capture.getMessages());
    expect(healthyResult.success).toBe(true);
    expect(new Set(delivered.map((message) => message.content.id))).toEqual(
      new Set(ids),
    );
    await waitFor(async () => {
      const counts = await queueCounts(queue.url);
      return counts.visible === 0 && counts.inFlight === 0;
    }, "successfully delivered SQS messages to be deleted");
  }, 45_000);
});
