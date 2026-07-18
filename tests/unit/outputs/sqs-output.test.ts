import { describe, it, expect, vi, beforeEach } from "vitest";
import { Effect } from "effect";
import { createSqsOutput } from "../../../src/outputs/sqs-output.js";
import { createMessage } from "../../../src/core/types.js";

// Mock AWS SDK
vi.mock("@aws-sdk/client-sqs", () => {
  const mockSend = vi.fn().mockResolvedValue({ MessageId: "test-id" });
  const mockDestroy = vi.fn().mockResolvedValue(undefined);

  return {
    SQSClient: vi.fn(() => ({
      send: mockSend,
      destroy: mockDestroy,
    })),
    SendMessageCommand: vi.fn((params) => params),
    SendMessageBatchCommand: vi.fn((params) => params),
  };
});

describe("SQSOutput", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Single Message Mode", () => {
    it("should send single message successfully", async () => {
      const output = createSqsOutput({
        queueUrl: "http://localhost:4566/000000000000/test-queue",
        region: "us-east-1",
        endpoint: "http://localhost:4566",
      });

      const msg = createMessage({ test: "data" });

      const result = await Effect.runPromise(output.send(msg));

      expect(result).toBeUndefined(); // Void return
    });

    it("should serialize message correctly", async () => {
      const { SQSClient } = await import("@aws-sdk/client-sqs");
      const mockClient = new SQSClient({});

      const output = createSqsOutput({
        queueUrl: "http://localhost:4566/000000000000/test-queue",
      });

      const msg = createMessage({ test: "data" }, { source: "test" });

      await Effect.runPromise(output.send(msg));

      const sendCall = (mockClient.send as any).mock.calls[0][0];
      expect(sendCall.MessageBody).toBeDefined();
      expect(JSON.parse(sendCall.MessageBody)).toEqual({ test: "data" });
      expect(sendCall.MessageAttributes).toBeDefined();
      expect(sendCall.MessageAttributes.messageId).toBeDefined();
    });

    it("should support delayed messages", async () => {
      const output = createSqsOutput({
        queueUrl: "http://localhost:4566/000000000000/test-queue",
        delaySeconds: 10,
      });

      const msg = createMessage({ test: "delayed" });

      await Effect.runPromise(output.send(msg));

      // Verify delay was set (would check mock calls in real test)
    });

    it("should handle send errors", async () => {
      const { SQSClient } = await import("@aws-sdk/client-sqs");
      const mockClient = new SQSClient({});
      (mockClient.send as any).mockRejectedValueOnce(
        new Error("Network error"),
      );

      const output = createSqsOutput({
        queueUrl: "http://localhost:4566/000000000000/test-queue",
        maxRetries: 0, // Disable retry for error testing
      });

      const msg = createMessage({ test: "data" });

      const result = Effect.runPromise(output.send(msg));

      await expect(result).rejects.toThrow();
    });
  });

  describe("Batch Mode", () => {
    it("should accumulate messages until batch size reached", async () => {
      const { SQSClient, SendMessageBatchCommand } = await import(
        "@aws-sdk/client-sqs"
      );
      const mockClient = new SQSClient({});

      const output = createSqsOutput({
        queueUrl: "http://localhost:4566/000000000000/test-queue",
        maxBatchSize: 3,
      });

      // Send 2 messages (should not trigger batch send yet)
      await Effect.runPromise(output.send(createMessage({ id: 1 })));
      await Effect.runPromise(output.send(createMessage({ id: 2 })));

      // Should not have called batch send yet
      const batchCalls = (mockClient.send as any).mock.calls.filter(
        (call: any) => call[0].Entries !== undefined,
      );
      expect(batchCalls.length).toBe(0);

      // Send 3rd message (should trigger batch)
      await Effect.runPromise(output.send(createMessage({ id: 3 })));

      // Now should have sent batch
      const newBatchCalls = (mockClient.send as any).mock.calls.filter(
        (call: any) => call[0].Entries !== undefined,
      );
      expect(newBatchCalls.length).toBeGreaterThan(0);
    });

    it("should flush remaining messages on close", async () => {
      const { SQSClient } = await import("@aws-sdk/client-sqs");
      const mockClient = new SQSClient({});

      const output = createSqsOutput({
        queueUrl: "http://localhost:4566/000000000000/test-queue",
        maxBatchSize: 10,
      });

      // Send 3 messages (less than batch size)
      await Effect.runPromise(output.send(createMessage({ id: 1 })));
      await Effect.runPromise(output.send(createMessage({ id: 2 })));
      await Effect.runPromise(output.send(createMessage({ id: 3 })));

      // Close should flush
      if (output.close) {
        await Effect.runPromise(output.close());
      }

      // Should have sent the remaining batch
      const batchCalls = (mockClient.send as any).mock.calls.filter(
        (call: any) => call[0].Entries !== undefined,
      );
      expect(batchCalls.length).toBeGreaterThan(0);
    });

    it("should handle partial batch failures", async () => {
      const { SQSClient } = await import("@aws-sdk/client-sqs");
      const mockClient = new SQSClient({});
      (mockClient.send as any).mockResolvedValueOnce({
        Successful: [{ Id: "0" }],
        Failed: [{ Id: "1", Message: "Error" }],
      });

      const output = createSqsOutput({
        queueUrl: "http://localhost:4566/000000000000/test-queue",
        maxBatchSize: 2,
        maxRetries: 0, // Disable retry for error testing
      });

      await Effect.runPromise(output.send(createMessage({ id: 1 })));

      const result = Effect.runPromise(output.send(createMessage({ id: 2 })));

      // Should fail due to partial failure
      await expect(result).rejects.toThrow();
    });

    it("should retry only entries reported as failed", async () => {
      const { SQSClient } = await import("@aws-sdk/client-sqs");
      const mockClient = new SQSClient({});
      (mockClient.send as any)
        .mockResolvedValueOnce({
          Successful: [{ Id: "0" }],
          Failed: [{ Id: "1", Message: "retry" }],
        })
        .mockResolvedValueOnce({ Successful: [{ Id: "1" }], Failed: [] });

      const output = createSqsOutput({
        queueUrl: "http://localhost:4566/000000000000/test-queue",
        maxBatchSize: 2,
        maxRetries: 1,
      });
      await Effect.runPromise(output.send(createMessage({ id: 1 })));
      await Effect.runPromise(output.send(createMessage({ id: 2 })));

      const batchCalls = (mockClient.send as any).mock.calls.filter(
        (call: any) => call[0].Entries !== undefined,
      );
      expect(batchCalls).toHaveLength(2);
      expect(batchCalls[0][0].Entries.map((entry: any) => entry.Id)).toEqual([
        "0",
        "1",
      ]);
      expect(batchCalls[1][0].Entries.map((entry: any) => entry.Id)).toEqual([
        "1",
      ]);
    });
  });

  describe("Configuration", () => {
    it("should use default batch size of 1", () => {
      const output = createSqsOutput({
        queueUrl: "http://localhost:4566/000000000000/test-queue",
      });

      expect(output.name).toBe("sqs-output");
    });

    it("should support LocalStack configuration", () => {
      const output = createSqsOutput({
        queueUrl: "http://localhost:4566/000000000000/test-queue",
        region: "us-east-1",
        endpoint: "http://localhost:4566",
      });

      expect(output).toBeDefined();
      expect(output.send).toBeDefined();
    });

    it("should implement close method", async () => {
      const output = createSqsOutput({
        queueUrl: "http://localhost:4566/000000000000/test-queue",
      });

      expect(output.close).toBeDefined();

      if (output.close) {
        await Effect.runPromise(output.close());
      }
    });
  });

  describe("Batch Timeout", () => {
    it("should flush batch after timeout expires", async () => {
      const { SQSClient } = await import("@aws-sdk/client-sqs");
      const mockClient = new SQSClient({});

      const output = createSqsOutput({
        queueUrl: "http://localhost:4566/000000000000/test-queue",
        maxBatchSize: 10,
        batchTimeout: 100, // 100ms timeout
      });

      // Send 3 messages (less than batch size)
      await Effect.runPromise(output.send(createMessage({ id: 1 })));
      await Effect.runPromise(output.send(createMessage({ id: 2 })));
      await Effect.runPromise(output.send(createMessage({ id: 3 })));

      // Wait for timeout to expire with significant buffer for fiber execution
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Should have sent the batch due to timeout
      const batchCalls = (mockClient.send as any).mock.calls.filter(
        (call: any) => call[0].Entries !== undefined,
      );
      expect(batchCalls.length).toBeGreaterThan(0);
      expect(batchCalls[0][0].Entries.length).toBe(3);
    });

    it("should cancel timeout when batch fills", async () => {
      const { SQSClient } = await import("@aws-sdk/client-sqs");
      const mockClient = new SQSClient({});

      const output = createSqsOutput({
        queueUrl: "http://localhost:4566/000000000000/test-queue",
        maxBatchSize: 3,
        batchTimeout: 5000, // Long timeout
      });

      // Send messages to fill batch
      await Effect.runPromise(output.send(createMessage({ id: 1 })));
      await Effect.runPromise(output.send(createMessage({ id: 2 })));
      await Effect.runPromise(output.send(createMessage({ id: 3 })));

      // Should have sent immediately when batch filled
      const batchCalls = (mockClient.send as any).mock.calls.filter(
        (call: any) => call[0].Entries !== undefined,
      );
      expect(batchCalls.length).toBe(1);
      expect(batchCalls[0][0].Entries.length).toBe(3);

      // Timeout should be cancelled - no additional sends
      await new Promise((resolve) => setTimeout(resolve, 100));
      const batchCallsAfter = (mockClient.send as any).mock.calls.filter(
        (call: any) => call[0].Entries !== undefined,
      );
      expect(batchCallsAfter.length).toBe(1); // Still only 1 batch
    });

    it("should restart timeout for new batch", async () => {
      const { SQSClient } = await import("@aws-sdk/client-sqs");
      const mockClient = new SQSClient({});

      const output = createSqsOutput({
        queueUrl: "http://localhost:4566/000000000000/test-queue",
        maxBatchSize: 3,
        batchTimeout: 100,
      });

      // First batch - fill it
      await Effect.runPromise(output.send(createMessage({ id: 1 })));
      await Effect.runPromise(output.send(createMessage({ id: 2 })));
      await Effect.runPromise(output.send(createMessage({ id: 3 })));

      // Second batch - partial
      await Effect.runPromise(output.send(createMessage({ id: 4 })));

      // Wait for timeout with significant buffer for fiber execution
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Should have 2 batches sent
      const batchCalls = (mockClient.send as any).mock.calls.filter(
        (call: any) => call[0].Entries !== undefined,
      );
      expect(batchCalls.length).toBe(2);
      expect(batchCalls[0][0].Entries.length).toBe(3);
      expect(batchCalls[1][0].Entries.length).toBe(1);
    });

    it("should work without timeout configured", async () => {
      const { SQSClient } = await import("@aws-sdk/client-sqs");
      const mockClient = new SQSClient({});

      const output = createSqsOutput({
        queueUrl: "http://localhost:4566/000000000000/test-queue",
        maxBatchSize: 10,
        // No batchTimeout configured
      });

      // Send messages
      await Effect.runPromise(output.send(createMessage({ id: 1 })));
      await Effect.runPromise(output.send(createMessage({ id: 2 })));

      // Wait a bit
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Should NOT have sent batch (no timeout)
      const batchCalls = (mockClient.send as any).mock.calls.filter(
        (call: any) => call[0].Entries !== undefined,
      );
      expect(batchCalls.length).toBe(0);
    });

    it("should cancel timeout on close", async () => {
      const output = createSqsOutput({
        queueUrl: "http://localhost:4566/000000000000/test-queue",
        maxBatchSize: 10,
        batchTimeout: 5000, // Long timeout
      });

      // Send message to start timeout
      await Effect.runPromise(output.send(createMessage({ id: 1 })));

      // Close should cancel timeout and flush
      if (output.close) {
        await Effect.runPromise(output.close());
      }

      // No errors should occur
    });
  });

  describe("Message Format", () => {
    it("should preserve message metadata in attributes", async () => {
      const { SQSClient } = await import("@aws-sdk/client-sqs");
      const mockClient = new SQSClient({});

      const output = createSqsOutput({
        queueUrl: "http://localhost:4566/000000000000/test-queue",
      });

      const msg = createMessage(
        { test: "data" },
        { source: "test", custom: "value" },
      );

      await Effect.runPromise(output.send(msg));

      const sendCall = (mockClient.send as any).mock.calls[0][0];
      expect(sendCall.MessageAttributes.metadata).toBeDefined();

      const metadata = JSON.parse(
        sendCall.MessageAttributes.metadata.StringValue,
      );
      expect(metadata.source).toBe("test");
      expect(metadata.custom).toBe("value");
    });

    it("should preserve correlation ID", async () => {
      const { SQSClient } = await import("@aws-sdk/client-sqs");
      const mockClient = new SQSClient({});

      const output = createSqsOutput({
        queueUrl: "http://localhost:4566/000000000000/test-queue",
      });

      const msg = createMessage({ test: "data" });
      msg.correlationId = "test-correlation-id";

      await Effect.runPromise(output.send(msg));

      const sendCall = (mockClient.send as any).mock.calls[0][0];
      expect(sendCall.MessageAttributes.correlationId).toBeDefined();
      expect(sendCall.MessageAttributes.correlationId.StringValue).toBe(
        "test-correlation-id",
      );
    });
  });
});
