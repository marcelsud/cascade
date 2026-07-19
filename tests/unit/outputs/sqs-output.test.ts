import { beforeEach, describe, expect, it, vi } from "vitest";
import { Effect, Exit, Fiber, Stream } from "effect";
import { createSqsOutput } from "../../../src/outputs/sqs-output.js";
import { withDLQ } from "../../../src/core/dlq.js";
import { run as runPipeline } from "../../../src/core/pipeline.js";
import {
  createMessage,
  type Message,
  type Output,
} from "../../../src/core/types.js";

// Mock AWS SDK
vi.mock("@aws-sdk/client-sqs", () => {
  const mockSend = vi.fn().mockResolvedValue({ Successful: [], Failed: [] });
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

const getMockClient = async () => {
  const { SQSClient } = await import("@aws-sdk/client-sqs");
  return new SQSClient({}) as any;
};

const batchCalls = (mockClient: any) =>
  mockClient.send.mock.calls.filter(
    (call: any) => call[0].Entries !== undefined,
  );

const runMessages = (
  output: ReturnType<typeof createSqsOutput>,
  messages: Message[],
) =>
  Effect.runPromise(
    runPipeline({
      name: "sqs-batch-test",
      input: {
        name: "test-input",
        stream: Stream.fromIterable(messages),
      },
      processors: [],
      output,
    }),
  );

describe("SQSOutput", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const mockClient = await getMockClient();
    mockClient.send.mockReset();
    mockClient.send.mockResolvedValue({ Successful: [], Failed: [] });
    mockClient.destroy.mockReset();
    mockClient.destroy.mockResolvedValue(undefined);
  });

  describe("Single Message Mode", () => {
    it("should send single message successfully", async () => {
      const output = createSqsOutput({
        queueUrl: "http://localhost:4566/000000000000/test-queue",
        region: "us-east-1",
        endpoint: "http://localhost:4566",
      });

      const result = await Effect.runPromise(
        output.send(createMessage({ test: "data" })),
      );

      expect(result).toBeUndefined();
    });

    it("should serialize message correctly", async () => {
      const mockClient = await getMockClient();
      const output = createSqsOutput({
        queueUrl: "http://localhost:4566/000000000000/test-queue",
      });

      await Effect.runPromise(
        output.send(createMessage({ test: "data" }, { source: "test" })),
      );

      const sendCall = mockClient.send.mock.calls[0][0];
      expect(JSON.parse(sendCall.MessageBody)).toEqual({ test: "data" });
      expect(sendCall.MessageAttributes.messageId).toBeDefined();
    });

    it("should support delayed messages", async () => {
      const mockClient = await getMockClient();
      const output = createSqsOutput({
        queueUrl: "http://localhost:4566/000000000000/test-queue",
        delaySeconds: 10,
      });

      await Effect.runPromise(output.send(createMessage({ test: "delayed" })));

      expect(mockClient.send.mock.calls[0][0].DelaySeconds).toBe(10);
    });

    it("should handle send errors", async () => {
      const mockClient = await getMockClient();
      mockClient.send.mockRejectedValueOnce(new Error("Network error"));
      const output = createSqsOutput({
        queueUrl: "http://localhost:4566/000000000000/test-queue",
        maxRetries: 0,
      });

      await expect(
        Effect.runPromise(output.send(createMessage({ test: "data" }))),
      ).rejects.toThrow("Network error");
    });
  });

  describe("Batch Delivery Completion", () => {
    it("does not acknowledge source messages until SQS accepts their batch", async () => {
      const mockClient = await getMockClient();
      let acceptBatch!: (value: {
        Successful: unknown[];
        Failed: unknown[];
      }) => void;
      mockClient.send.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            acceptBatch = resolve;
          }),
      );

      const firstAck = vi.fn();
      const secondAck = vi.fn();
      const first: Message = {
        ...createMessage({ id: 1 }),
        ack: () => Effect.sync(firstAck),
      };
      const second: Message = {
        ...createMessage({ id: 2 }),
        ack: () => Effect.sync(secondAck),
      };
      const output = createSqsOutput({
        queueUrl: "http://localhost:4566/000000000000/test-queue",
        maxBatchSize: 2,
        batchTimeout: 5_000,
      });

      const pipelineResult = runMessages(output, [first, second]);
      await vi.waitFor(() => expect(batchCalls(mockClient)).toHaveLength(1));

      expect(firstAck).not.toHaveBeenCalled();
      expect(secondAck).not.toHaveBeenCalled();

      acceptBatch({ Successful: [{ Id: "0" }, { Id: "1" }], Failed: [] });
      const result = await pipelineResult;

      expect(result.success).toBe(true);
      expect(firstAck).toHaveBeenCalledOnce();
      expect(secondAck).toHaveBeenCalledOnce();
    });

    it("leaves source messages unacknowledged when their batch flush fails", async () => {
      const mockClient = await getMockClient();
      mockClient.send.mockRejectedValueOnce(new Error("SQS unavailable"));
      const firstAck = vi.fn();
      const secondAck = vi.fn();
      const messages: Message[] = [
        {
          ...createMessage({ id: 1 }),
          ack: () => Effect.sync(firstAck),
        },
        {
          ...createMessage({ id: 2 }),
          ack: () => Effect.sync(secondAck),
        },
      ];
      const output = createSqsOutput({
        queueUrl: "http://localhost:4566/000000000000/test-queue",
        maxBatchSize: 2,
        maxRetries: 0,
        batchTimeout: 5_000,
      });

      const result = await runMessages(output, messages);

      expect(result.success).toBe(false);
      expect(result.stats.failed).toBe(2);
      expect(firstAck).not.toHaveBeenCalled();
      expect(secondAck).not.toHaveBeenCalled();
    });

    it("completes the source ack after a timeout flush succeeds", async () => {
      const mockClient = await getMockClient();
      const ack = vi.fn();
      const message: Message = {
        ...createMessage({ id: 1 }),
        ack: () => Effect.sync(ack),
      };
      const output = createSqsOutput({
        queueUrl: "http://localhost:4566/000000000000/test-queue",
        maxBatchSize: 10,
        batchTimeout: 20,
      });

      const result = await runMessages(output, [message]);

      expect(result.success).toBe(true);
      expect(ack).toHaveBeenCalledOnce();
      expect(batchCalls(mockClient)).toHaveLength(1);
      expect(batchCalls(mockClient)[0][0].Entries).toHaveLength(1);
    });

    it("uses a bounded default linger so a partial batch cannot deadlock", async () => {
      const mockClient = await getMockClient();
      const output = createSqsOutput({
        queueUrl: "http://localhost:4566/000000000000/test-queue",
        maxBatchSize: 10,
      });

      await Effect.runPromise(output.send(createMessage({ id: 1 })));

      expect(batchCalls(mockClient)).toHaveLength(1);
    });

    it("propagates a final close flush failure to close and waiting sends", async () => {
      const mockClient = await getMockClient();
      mockClient.send.mockRejectedValueOnce(new Error("final flush failed"));
      const output = createSqsOutput({
        queueUrl: "http://localhost:4566/000000000000/test-queue",
        maxBatchSize: 10,
        maxRetries: 0,
        batchTimeout: 5_000,
      });

      const pendingSend = Effect.runPromise(
        output.send(createMessage({ id: 1 })),
      );
      const sendFailure =
        expect(pendingSend).rejects.toThrow("final flush failed");
      await new Promise((resolve) => setTimeout(resolve, 10));

      await expect(Effect.runPromise(output.close!())).rejects.toThrow(
        "final flush failed",
      );
      await sendFailure;
    });

    it("fails sibling completions when a batch send is interrupted", async () => {
      const mockClient = await getMockClient();
      mockClient.send.mockImplementationOnce(() => new Promise(() => {}));
      const output = createSqsOutput({
        queueUrl: "http://localhost:4566/000000000000/test-queue",
        maxBatchSize: 2,
        batchTimeout: 5_000,
      });

      const first = Effect.runFork(output.send(createMessage({ id: 1 })));
      await new Promise((resolve) => setTimeout(resolve, 5));
      const coordinator = Effect.runFork(
        output.send(createMessage({ id: 2 })),
      );
      await vi.waitFor(() => expect(batchCalls(mockClient)).toHaveLength(1));

      await Effect.runPromise(Fiber.interrupt(coordinator));
      const firstExit = await Effect.runPromise(
        Fiber.await(first).pipe(Effect.timeout("200 millis")),
      );

      expect(Exit.isFailure(firstExit)).toBe(true);
      await Effect.runPromise(output.close!());
    });
  });

  describe("Batch Partial Failures", () => {
    it("retries only entries that SQS rejected", async () => {
      const mockClient = await getMockClient();
      mockClient.send
        .mockResolvedValueOnce({
          Successful: [{ Id: "0" }],
          Failed: [{ Id: "1", Message: "retry", SenderFault: false }],
        })
        .mockResolvedValueOnce({ Successful: [{ Id: "0" }], Failed: [] });
      const output = createSqsOutput({
        queueUrl: "http://localhost:4566/000000000000/test-queue",
        maxBatchSize: 2,
        maxRetries: 1,
        batchTimeout: 5_000,
      });

      await Promise.all([
        Effect.runPromise(output.send(createMessage({ id: 1 }))),
        Effect.runPromise(output.send(createMessage({ id: 2 }))),
      ]);

      const calls = batchCalls(mockClient);
      expect(calls).toHaveLength(2);
      expect(calls[0][0].Entries).toHaveLength(2);
      expect(calls[1][0].Entries).toHaveLength(1);
      expect(JSON.parse(calls[1][0].Entries[0].MessageBody)).toEqual({ id: 2 });
    });

    it("routes only the rejected entry through the per-message DLQ wrapper", async () => {
      const mockClient = await getMockClient();
      mockClient.send.mockResolvedValueOnce({
        Successful: [{ Id: "0" }],
        Failed: [{ Id: "1", Message: "rejected", SenderFault: true }],
      });
      const primary = createSqsOutput({
        queueUrl: "http://localhost:4566/000000000000/test-queue",
        maxBatchSize: 2,
        maxRetries: 0,
        batchTimeout: 5_000,
      });
      const dlqSend = vi.fn().mockReturnValue(Effect.void);
      const dlq: Output<Error> = { name: "test-dlq", send: dlqSend };
      const output = withDLQ({
        output: primary,
        dlq,
        maxRetries: 0,
      });

      await Promise.all([
        Effect.runPromise(output.send(createMessage({ id: 1 }))),
        Effect.runPromise(output.send(createMessage({ id: 2 }))),
      ]);

      expect(dlqSend).toHaveBeenCalledOnce();
      expect(dlqSend.mock.calls[0][0].content).toEqual({ id: 2 });
    });

    it("starts a new timeout after a timeout-driven batch fails", async () => {
      const mockClient = await getMockClient();
      mockClient.send
        .mockRejectedValueOnce(new Error("first timeout failed"))
        .mockResolvedValueOnce({ Successful: [{ Id: "0" }], Failed: [] });
      const output = createSqsOutput({
        queueUrl: "http://localhost:4566/000000000000/test-queue",
        maxBatchSize: 10,
        maxRetries: 0,
        batchTimeout: 20,
      });

      await expect(
        Effect.runPromise(output.send(createMessage({ id: 1 }))),
      ).rejects.toThrow("first timeout failed");
      await Effect.runPromise(output.send(createMessage({ id: 2 })));

      expect(batchCalls(mockClient)).toHaveLength(2);
    });
  });

  describe("Configuration and Message Format", () => {
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

      expect(output.send).toBeDefined();
      expect(output.close).toBeDefined();
    });

    it("should preserve message metadata and correlation ID", async () => {
      const mockClient = await getMockClient();
      const output = createSqsOutput({
        queueUrl: "http://localhost:4566/000000000000/test-queue",
      });
      const message: Message = {
        ...createMessage({ test: "data" }, { source: "test", custom: "value" }),
        correlationId: "test-correlation-id",
      };

      await Effect.runPromise(output.send(message));

      const sendCall = mockClient.send.mock.calls[0][0];
      const metadata = JSON.parse(
        sendCall.MessageAttributes.metadata.StringValue,
      );
      expect(metadata).toEqual({ source: "test", custom: "value" });
      expect(sendCall.MessageAttributes.correlationId.StringValue).toBe(
        "test-correlation-id",
      );
    });
  });
});
