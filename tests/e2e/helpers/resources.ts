import { randomUUID } from "node:crypto";
import {
  CreateQueueCommand,
  DeleteMessageBatchCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
  type Message,
  type QueueAttributeName,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import type Redis from "ioredis";
import { createRedisClient, createSqsClient } from "./infrastructure.js";

const safeName = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .slice(0, 32);

export const uniqueResourceName = (label: string): string => {
  const worker = process.env.VITEST_POOL_ID ?? "0";
  return `cascade-e2e-${safeName(label)}-${worker}-${Date.now()}-${randomUUID().slice(0, 8)}`;
};

export interface E2EQueue {
  readonly name: string;
  readonly url: string;
}

export class E2EResources {
  readonly sqs: SQSClient = createSqsClient();
  readonly redis: Redis = createRedisClient();
  private readonly cleanups: Array<() => Promise<unknown>> = [];

  async createQueue(
    label: string,
    attributes?: Partial<Record<QueueAttributeName, string>>,
  ): Promise<E2EQueue> {
    const name = uniqueResourceName(label);
    const response = await this.sqs.send(
      new CreateQueueCommand({ QueueName: name, Attributes: attributes }),
    );
    if (!response.QueueUrl) throw new Error(`No QueueUrl returned for ${name}`);

    const url = response.QueueUrl;
    this.cleanups.push(() =>
      this.sqs.send(new DeleteQueueCommand({ QueueUrl: url })),
    );
    return { name, url };
  }

  async redisKey(label: string): Promise<string> {
    if (this.redis.status === "wait") await this.redis.connect();
    const key = uniqueResourceName(label);
    this.cleanups.push(() => this.redis.del(key));
    return key;
  }

  async drainQueue(queueUrl: string, expectedCount = 0): Promise<Message[]> {
    const messages: Message[] = [];
    const deadline = Date.now() + 10_000;

    while (Date.now() < deadline) {
      const response = await this.sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: messages.length >= expectedCount ? 0 : 1,
        }),
      );
      const batch = response.Messages ?? [];
      if (batch.length === 0 && messages.length >= expectedCount) break;
      if (batch.length === 0) continue;

      messages.push(...batch);
      const entries = batch.flatMap((message, index) =>
        message.ReceiptHandle
          ? [{ Id: String(index), ReceiptHandle: message.ReceiptHandle }]
          : [],
      );
      if (entries.length > 0) {
        const deleted = await this.sqs.send(
          new DeleteMessageBatchCommand({
            QueueUrl: queueUrl,
            Entries: entries,
          }),
        );
        if (deleted.Failed && deleted.Failed.length > 0) {
          throw new Error(
            `Failed to drain SQS messages: ${JSON.stringify(deleted.Failed)}`,
          );
        }
      }
    }

    return messages;
  }

  async cleanup(): Promise<void> {
    const results = await Promise.allSettled(
      this.cleanups.reverse().map((cleanup) => cleanup()),
    );
    this.sqs.destroy();
    this.redis.disconnect();

    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure) throw failure.reason;
  }
}
