import { describe, expect, it } from "vitest";
import { Effect, Fiber, Logger, Stream, TestClock } from "effect";
import * as TestContext from "effect/TestContext";
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
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
  options: {
    readonly waitTimeSeconds?: number;
  } = { waitTimeSeconds: 0 },
) => {
  const sqsInput = createSqsInput(
    {
      queueUrl: "http://localhost:4566/000000000000/test-queue",
      endpoint: "http://localhost:4566",
      ...options,
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

const receiveWaitTimeSeconds = (
  command: ReceiveMessageCommand | DeleteMessageCommand | undefined,
) => {
  expect(command).toBeInstanceOf(ReceiveMessageCommand);
  return (command as ReceiveMessageCommand).input.WaitTimeSeconds;
};

describe("SQS ReceiveMessage wait time", () => {
  it("sends WaitTimeSeconds 0 when waitTimeSeconds is explicitly 0", async () => {
    const { client, commands } = createMockClient();

    await Effect.runPromise(
      runOneSqsMessage(
        client,
        {
          name: "success-output",
          send: () => Effect.void,
        },
        { waitTimeSeconds: 0 },
      ),
    );

    expect(receiveWaitTimeSeconds(commands[0])).toBe(0);
  });

  it("defaults WaitTimeSeconds to 20 when waitTimeSeconds is omitted", async () => {
    const { client, commands } = createMockClient();

    await Effect.runPromise(
      runOneSqsMessage(
        client,
        {
          name: "success-output",
          send: () => Effect.void,
        },
        {},
      ),
    );

    expect(receiveWaitTimeSeconds(commands[0])).toBe(20);
  });
});

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

describe("SQS polling recovery", () => {
  it("re-polls after an exhausted transient receive cycle", async () => {
    const commands: Array<ReceiveMessageCommand | DeleteMessageCommand> = [];
    let receiveAttempts = 0;
    const client: SqsClientLike = {
      send: async (command) => {
        commands.push(command);
        if (command instanceof ReceiveMessageCommand) {
          receiveAttempts += 1;
          if (receiveAttempts <= 4) {
            throw new Error("network timeout");
          }
          return {
            Messages: [
              {
                MessageId: "message-1",
                Body: '{"value":1}',
              },
            ],
          };
        }
        return {};
      },
      destroy: () => undefined,
    };

    const captured: unknown[] = [];
    const logMessages: unknown[] = [];
    const logger = Logger.make<unknown, void>(({ message }) => {
      logMessages.push(message);
    });

    const sqsInput = createSqsInput(
      {
        queueUrl: "http://localhost:4566/000000000000/test-queue",
        endpoint: "http://localhost:4566",
        waitTimeSeconds: 0,
      },
      client,
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(
          run({
            name: "sqs-recovery-test",
            input: {
              ...sqsInput,
              stream: sqsInput.stream.pipe(Stream.take(1)),
            },
            processors: [],
            output: {
              name: "capture",
              send: (message) =>
                Effect.sync(() => {
                  captured.push(message.content);
                }),
            },
          }).pipe(Effect.provide(Logger.replace(Logger.defaultLogger, logger))),
        );

        yield* TestClock.adjust("13 seconds");
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(TestContext.TestContext)),
    );

    expect(
      commands.filter((command) => command instanceof ReceiveMessageCommand),
    ).toHaveLength(5);
    expect(
      commands.filter((command) => command instanceof DeleteMessageCommand),
    ).toHaveLength(0);
    expect(captured).toEqual([{ value: 1 }]);
    expect(result.success).toBe(true);
    expect(result.stats.processed).toBe(1);
    expect(result.stats.failed).toBe(0);
    expect(result.metrics?.input?.errorsEncountered).toBe(1);
    expect(JSON.stringify(logMessages)).toContain("SQS stream error");
  });

  it.each([
    ["logical", "validation failed"],
    ["fatal", "unauthorized"],
  ] as const)(
    "terminates on first %s receive error without retrying",
    async (category, errorMessage) => {
      const commands: Array<ReceiveMessageCommand | DeleteMessageCommand> = [];
      const client: SqsClientLike = {
        send: async (command) => {
          commands.push(command);
          if (command instanceof ReceiveMessageCommand) {
            throw new Error(errorMessage);
          }
          return {};
        },
        destroy: () => undefined,
      };

      const captured: unknown[] = [];
      const sqsInput = createSqsInput(
        {
          queueUrl: "http://localhost:4566/000000000000/test-queue",
          endpoint: "http://localhost:4566",
          waitTimeSeconds: 0,
        },
        client,
      );

      const result = await Effect.runPromise(
        run({
          name: "sqs-terminal-test",
          input: {
            ...sqsInput,
            stream: sqsInput.stream.pipe(Stream.take(1)),
          },
          processors: [],
          output: {
            name: "capture",
            send: (message) =>
              Effect.sync(() => {
                captured.push(message.content);
              }),
          },
        }),
      );

      expect(
        commands.filter((command) => command instanceof ReceiveMessageCommand),
      ).toHaveLength(1);
      expect(captured).toEqual([]);
      expect(result.success).toBe(false);
      expect(result.stats.failed).toBeGreaterThanOrEqual(1);
      expect(result.metrics?.input?.errorsEncountered).toBe(1);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            _tag: "SqsInputError",
            category,
          }),
        ]),
      );
    },
  );
});

const extractMessageMetadataSection = (markdown: string): string => {
  const match = markdown.match(/## Message Metadata\n([\s\S]*?)(?=\n## |\n*$)/);
  if (!match) {
    throw new Error("Message Metadata section not found");
  }
  return match[1];
};

describe("SQS emitted message metadata contract", () => {
  it("emits source sqs-input and does not generate correlation IDs", async () => {
    const { client } = createMockClient();
    let captured: Message | undefined;

    await Effect.runPromise(
      runOneSqsMessage(client, {
        name: "capture-output",
        send: (message) =>
          Effect.sync(() => {
            captured = message;
          }),
      }),
    );

    expect(captured).toBeDefined();
    expect(captured!.metadata.source).toBe("sqs-input");
    expect(captured!.correlationId).toBeUndefined();
    expect(captured!.metadata.correlationId).toBeUndefined();
  });

  it("documents the same source and correlation contract as runtime", async () => {
    const { client } = createMockClient();
    let captured: Message | undefined;

    await Effect.runPromise(
      runOneSqsMessage(client, {
        name: "capture-output",
        send: (message) =>
          Effect.sync(() => {
            captured = message;
          }),
      }),
    );

    expect(captured).toBeDefined();

    const docsPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../docs/inputs/sqs.md",
    );
    const section = extractMessageMetadataSection(
      readFileSync(docsPath, "utf8"),
    );

    const documentedSource = section.match(/`source`:\s*"([^"]+)"/)?.[1];
    expect(documentedSource).toBe(captured!.metadata.source);
    expect(documentedSource).toBe("sqs-input");
    expect(section).not.toMatch(
      /correlationId.*Auto-generated if not present/i,
    );
    expect(section).not.toMatch(/auto-generat/i);

    // Docs must not claim generation when runtime emits neither field.
    expect(captured!.correlationId).toBeUndefined();
    expect(captured!.metadata.correlationId).toBeUndefined();
    expect(section.toLowerCase()).toContain("metadata processor");
  });
});
