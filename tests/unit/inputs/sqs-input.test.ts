import { describe, expect, it } from "vitest";
import { Effect, Stream } from "effect";
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
} from "@aws-sdk/client-sqs";
import {
  createSqsInput,
  type SqsClientLike,
} from "../../../src/inputs/sqs-input.js";
import { run } from "../../../src/core/pipeline.js";
import { withDLQ } from "../../../src/core/dlq.js";
import { createMessage, type Message } from "../../../src/core/types.js";

const createMockClient = () => {
  const commands: Array<ReceiveMessageCommand | DeleteMessageCommand> = [];
  const client: SqsClientLike = {
    send: async (command) => {
      commands.push(command);
      if (command instanceof ReceiveMessageCommand) {
        return {
          Messages: [
            {
              MessageId: "message-1",
              ReceiptHandle: "receipt-1",
              Body: '{"value":1}',
            },
          ],
        };
      }
      return {};
    },
    destroy: () => undefined,
  };
  return { client, commands };
};

const runOneSqsMessage = (
  client: SqsClientLike,
  output: {
    readonly name: string;
    readonly send: (message: Message) => Effect.Effect<void, unknown>;
  },
) => {
  const sqsInput = createSqsInput(
    {
      queueUrl: "http://localhost:4566/000000000000/test-queue",
      endpoint: "http://localhost:4566",
      waitTimeSeconds: 0,
    },
    client,
  );

  return run({
    name: "sqs-ack-test",
    input: { ...sqsInput, stream: sqsInput.stream.pipe(Stream.take(1)) },
    processors: [],
    output,
  });
};

describe("SQS at-least-once acknowledgement", () => {
  it("deletes a message only after downstream output succeeds", async () => {
    const { client, commands } = createMockClient();

    const result = await Effect.runPromise(
      runOneSqsMessage(client, {
        name: "success-output",
        send: () => Effect.void,
      }),
    );

    expect(result.success).toBe(true);
    expect(commands).toHaveLength(2);
    expect(commands[0]).toBeInstanceOf(ReceiveMessageCommand);
    expect(commands[1]).toBeInstanceOf(DeleteMessageCommand);
  });

  it("does not delete a message when downstream output fails", async () => {
    const { client, commands } = createMockClient();

    const result = await Effect.runPromise(
      runOneSqsMessage(client, {
        name: "failing-output",
        send: () => Effect.fail("output failed"),
      }),
    );

    expect(result.success).toBe(false);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toBeInstanceOf(ReceiveMessageCommand);
  });

  it("surfaces DeleteMessage failure instead of swallowing it", async () => {
    const commands: Array<ReceiveMessageCommand | DeleteMessageCommand> = [];
    const client: SqsClientLike = {
      send: async (command) => {
        commands.push(command);
        if (command instanceof ReceiveMessageCommand) {
          return {
            Messages: [
              {
                MessageId: "message-1",
                ReceiptHandle: "receipt-1",
                Body: '{"value":1}',
              },
            ],
          };
        }
        throw new Error("delete failed");
      },
      destroy: () => undefined,
    };

    const result = await Effect.runPromise(
      runOneSqsMessage(client, {
        name: "success-output",
        send: () => Effect.void,
      }),
    );

    expect(result.success).toBe(false);
    expect(commands[1]).toBeInstanceOf(DeleteMessageCommand);
    expect(result.errors?.[0]).toMatchObject({ _tag: "SqsInputError" });
  });

  it("acknowledges once after every fan-out output succeeds", async () => {
    let acknowledgements = 0;
    const sent: unknown[] = [];
    const message = {
      ...createMessage({ value: 1 }),
      ack: () =>
        Effect.sync(() => {
          acknowledgements += 1;
        }),
    };

    const result = await Effect.runPromise(
      run({
        name: "fan-out-ack-test",
        input: { name: "one", stream: Stream.make(message) },
        processors: [
          {
            name: "fan-out",
            process: (source) =>
              Effect.succeed(
                [1, 2, 3].map((value) => ({
                  ...source,
                  content: { value },
                })),
              ),
          },
        ],
        output: {
          name: "capture",
          send: (outputMessage) =>
            Effect.sync(() => {
              sent.push(outputMessage.content);
            }),
        },
      }),
    );

    expect(result.success).toBe(true);
    expect(sent).toEqual([{ value: 1 }, { value: 2 }, { value: 3 }]);
    expect(acknowledgements).toBe(1);
  });

  it("acknowledges an intentionally filtered message", async () => {
    let acknowledgements = 0;
    let sends = 0;
    const message = {
      ...createMessage({ value: 1 }),
      ack: () =>
        Effect.sync(() => {
          acknowledgements += 1;
        }),
    };

    const result = await Effect.runPromise(
      run({
        name: "filtered-ack-test",
        input: { name: "one", stream: Stream.make(message) },
        processors: [
          {
            name: "filter",
            process: () => Effect.succeed([]),
          },
        ],
        output: {
          name: "unused",
          send: () =>
            Effect.sync(() => {
              sends += 1;
            }),
        },
      }),
    );

    expect(result.success).toBe(true);
    expect(sends).toBe(0);
    expect(acknowledgements).toBe(1);
  });

  it("acknowledges after a failed primary send reaches the DLQ", async () => {
    let acknowledgements = 0;
    const message = {
      ...createMessage({ value: 1 }),
      ack: () =>
        Effect.sync(() => {
          acknowledgements += 1;
        }),
    };
    const output = withDLQ({
      output: { name: "primary", send: () => Effect.fail("primary failed") },
      dlq: { name: "dlq", send: () => Effect.void },
      maxRetries: 0,
    });

    const result = await Effect.runPromise(
      run({
        name: "dlq-ack-test",
        input: { name: "one", stream: Stream.make(message) },
        processors: [],
        output,
      }),
    );

    expect(result.success).toBe(true);
    expect(acknowledgements).toBe(1);
  });

  it("does not acknowledge when both primary and DLQ sends fail", async () => {
    let acknowledgements = 0;
    const message = {
      ...createMessage({ value: 1 }),
      ack: () =>
        Effect.sync(() => {
          acknowledgements += 1;
        }),
    };
    const output = withDLQ({
      output: { name: "primary", send: () => Effect.fail("primary failed") },
      dlq: { name: "dlq", send: () => Effect.fail("dlq failed") },
      maxRetries: 0,
    });

    const result = await Effect.runPromise(
      run({
        name: "dlq-failure-ack-test",
        input: { name: "one", stream: Stream.make(message) },
        processors: [],
        output,
      }),
    );

    expect(result.success).toBe(false);
    expect(acknowledgements).toBe(0);
  });
});
