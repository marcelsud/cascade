import { describe, it, expect, vi, beforeEach } from "vitest";
import { Chunk, Duration, Effect, Schedule, Stream } from "effect";
import {
  createDLQRetrySchedule,
  withBackpressure,
  withDLQ,
  DLQError,
} from "../../../src/core/dlq.js";
import { create, run } from "../../../src/core/pipeline.js";
import { createMessage } from "../../../src/core/types.js";
import type { Output, Message } from "../../../src/core/types.js";


import {
  ComponentError,
  type ErrorCategory,
} from "../../../src/core/errors.js";

class CategorizedTestError extends ComponentError {
  readonly _tag = "CategorizedTestError";
  constructor(
    message: string,
    readonly category: ErrorCategory,
  ) {
    super(message);
  }
}
describe("Dead Letter Queue (DLQ)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["exponential", [1000, 2000, 4000, 8000]],
    ["linear", [1000, 2000, 3000, 4000]],
  ] as const)("builds the %s retry schedule", async (type, expected) => {
    const outputs = await Effect.runPromise(
      Schedule.run(createDLQRetrySchedule(type, 1_000), 0, [1, 2, 3, 4]),
    );
    expect(
      Chunk.toReadonlyArray(outputs).map((value) =>
        Duration.toMillis(value as Duration.Duration),
      ),
    ).toEqual(expected);
  });

  it("builds a fixed retry schedule", async () => {
    const outputs = await Effect.runPromise(
      Schedule.run(createDLQRetrySchedule("fixed", 1_000), 0, [1, 2, 3, 4]),
    );
    expect(Chunk.toReadonlyArray(outputs)).toEqual([0, 1, 2, 3]);
  });

  it("waits the fixed interval after a slow attempt completes", async () => {
    const attemptStarts: number[] = [];
    const slowFailure = Effect.suspend(() => {
      attemptStarts.push(Date.now());
      return Effect.sleep("60 millis").pipe(
        Effect.zipRight(Effect.fail(new Error("retry"))),
      );
    });

    await Effect.runPromise(
      Effect.either(
        slowFailure.pipe(
          Effect.retry({
            times: 2,
            schedule: createDLQRetrySchedule("fixed", 40),
          }),
        ),
      ),
    );

    expect(attemptStarts).toHaveLength(3);
    const gaps = attemptStarts.slice(1).map((start, index) => {
      const previous = attemptStarts[index];
      if (previous === undefined) throw new Error("Missing attempt timestamp");
      return start - previous;
    });
    expect(gaps.every((gap) => gap > 75)).toBe(true);
  });

  describe("withDLQ", () => {
    it("should send message successfully when output succeeds", async () => {
      const mockOutput: Output<Error> = {
        name: "mock-output",
        send: vi.fn().mockReturnValue(Effect.void),
      };

      const dlqOutput: Output<any> = {
        name: "dlq-output",
        send: vi.fn().mockReturnValue(Effect.void),
      };

      const wrappedOutput = withDLQ({
        output: mockOutput,
        dlq: dlqOutput,
        maxRetries: 3,
      });

      const msg = createMessage({ test: "data" });
      await Effect.runPromise(wrappedOutput.send(msg));

      // Should call primary output
      expect(mockOutput.send).toHaveBeenCalledTimes(1);
      expect(mockOutput.send).toHaveBeenCalledWith(msg);

      // Should NOT call DLQ
      expect(dlqOutput.send).not.toHaveBeenCalled();
    });

    it("should send to DLQ after max retries exceeded", async () => {
      const mockOutput: Output<Error> = {
        name: "mock-output",
        send: vi
          .fn()
          .mockReturnValue(Effect.fail(new Error("Persistent error"))),
      };

      const dlqOutput: Output<any> = {
        name: "dlq-output",
        send: vi.fn().mockReturnValue(Effect.void),
      };

      const wrappedOutput = withDLQ({
        output: mockOutput,
        dlq: dlqOutput,
        maxRetries: 2,
      });

      const msg = createMessage({ test: "data" });
      await Effect.runPromise(wrappedOutput.send(msg));

      // Should send to DLQ
      expect(dlqOutput.send).toHaveBeenCalledTimes(1);

      // Verify DLQ message contains failure information
      const dlqMessage = (dlqOutput.send as any).mock.calls[0][0] as Message;
      expect(dlqMessage.metadata.dlq).toBe(true);
      expect(dlqMessage.metadata.dlqReason).toContain("Persistent error");
      expect(dlqMessage.metadata.dlqAttempts).toBe(3);
      expect(dlqMessage.metadata.originalMessageId).toBe(msg.id);
    });

    it("should fail if DLQ send also fails", async () => {
      const mockOutput: Output<Error> = {
        name: "mock-output",
        send: vi.fn().mockReturnValue(Effect.fail(new Error("Primary error"))),
      };

      const dlqOutput: Output<any> = {
        name: "dlq-output",
        send: vi.fn().mockReturnValue(Effect.fail(new Error("DLQ error"))),
      };

      const wrappedOutput = withDLQ({
        output: mockOutput,
        dlq: dlqOutput,
        maxRetries: 1,
      });

      const msg = createMessage({ test: "data" });

      // Should fail with original error since DLQ also failed
      await expect(Effect.runPromise(wrappedOutput.send(msg))).rejects.toThrow(
        "Primary error",
      );

      expect(mockOutput.send).toHaveBeenCalled();
      expect(dlqOutput.send).toHaveBeenCalled();
    });

    it("should work without DLQ configured", async () => {
      const mockOutput: Output<Error> = {
        name: "mock-output",
        send: vi
          .fn()
          .mockReturnValue(Effect.fail(new Error("Error without DLQ"))),
      };

      const wrappedOutput = withDLQ({
        output: mockOutput,
        maxRetries: 1,
      });

      const msg = createMessage({ test: "data" });

      // Should fail without DLQ
      await expect(Effect.runPromise(wrappedOutput.send(msg))).rejects.toThrow(
        "Error without DLQ",
      );
    });

    it("should use custom retry schedule", async () => {
      let attempts = 0;
      const mockOutput: Output<Error> = {
        name: "mock-output",
        send: vi.fn().mockImplementation(() => {
          attempts++;
          return Effect.fail(new Error(`Attempt ${attempts}`));
        }),
      };

      const dlqOutput: Output<any> = {
        name: "dlq-output",
        send: vi.fn().mockReturnValue(Effect.void),
      };

      // Custom schedule with specific delay
      const wrappedOutput = withDLQ({
        output: mockOutput,
        dlq: dlqOutput,
        maxRetries: 2,
      });

      const msg = createMessage({ test: "data" });
      await Effect.runPromise(wrappedOutput.send(msg));

      // Should have tried at least once and sent to DLQ
      expect(attempts).toBeGreaterThanOrEqual(1);
      expect(dlqOutput.send).toHaveBeenCalledTimes(1);
    });

    it("should perform the configured number of retries", async () => {
      let attempts = 0;
      const mockOutput: Output<Error> = {
        name: "mock-output",
        send: vi.fn().mockReturnValue(
          Effect.suspend(() => {
            attempts++;
            return Effect.fail(new Error(`Attempt ${attempts}`));
          }),
        ),
      };
      const dlqOutput: Output<any> = {
        name: "dlq-output",
        send: vi.fn().mockReturnValue(Effect.void),
      };
      const wrappedOutput = withDLQ({
        output: mockOutput,
        dlq: dlqOutput,
        maxRetries: 2,
        retrySchedule: Schedule.spaced(0),
      });

      await Effect.runPromise(
        wrappedOutput.send(createMessage({ test: "data" })),
      );

      expect(attempts).toBe(3);
      expect(dlqOutput.send).toHaveBeenCalledTimes(1);
    });

    it("should support immediate DLQ forwarding with zero retries", async () => {
      let attempts = 0;
      const mockOutput: Output<Error> = {
        name: "mock-output",
        send: vi.fn().mockReturnValue(
          Effect.suspend(() => {
            attempts++;
            return Effect.fail(new Error("Immediate failure"));
          }),
        ),
      };
      const dlqOutput: Output<any> = {
        name: "dlq-output",
        send: vi.fn().mockReturnValue(Effect.void),
      };
      const wrappedOutput = withDLQ({
        output: mockOutput,
        dlq: dlqOutput,
        maxRetries: 0,
        retrySchedule: Schedule.spaced(0),
      });

      await Effect.runPromise(
        wrappedOutput.send(createMessage({ test: "data" })),
      );

      expect(attempts).toBe(1);
      expect(dlqOutput.send).toHaveBeenCalledTimes(1);
    });

    it("retries only intermittent errors up to maxRetries + 1 attempts", async () => {
      let attempts = 0;
      const mockOutput: Output<Error> = {
        name: "mock-output",
        send: vi.fn().mockReturnValue(
          Effect.suspend(() => {
            attempts++;
            return Effect.fail(
              new CategorizedTestError("flaky", "intermittent"),
            );
          }),
        ),
      };
      const dlqOutput: Output<any> = {
        name: "dlq-output",
        send: vi.fn().mockReturnValue(Effect.void),
      };
      const wrappedOutput = withDLQ({
        output: mockOutput,
        dlq: dlqOutput,
        maxRetries: 2,
        retrySchedule: Schedule.spaced(0),
      });

      await Effect.runPromise(
        wrappedOutput.send(createMessage({ test: "data" })),
      );

      expect(attempts).toBe(3);
      expect(dlqOutput.send).toHaveBeenCalledTimes(1);
      const dlqMessage = (dlqOutput.send as any).mock.calls[0][0] as Message;
      expect(dlqMessage.metadata.dlqAttempts).toBe(3);
    });

    it("sends logical failures to DLQ after one primary attempt", async () => {
      let attempts = 0;
      const mockOutput: Output<Error> = {
        name: "mock-output",
        send: vi.fn().mockReturnValue(
          Effect.suspend(() => {
            attempts++;
            return Effect.fail(new CategorizedTestError("bad data", "logical"));
          }),
        ),
      };
      const dlqOutput: Output<any> = {
        name: "dlq-output",
        send: vi.fn().mockReturnValue(Effect.void),
      };
      const wrappedOutput = withDLQ({
        output: mockOutput,
        dlq: dlqOutput,
        maxRetries: 5,
        retrySchedule: Schedule.spaced(0),
      });

      await Effect.runPromise(
        wrappedOutput.send(createMessage({ test: "data" })),
      );

      expect(attempts).toBe(1);
      expect(dlqOutput.send).toHaveBeenCalledTimes(1);
      const dlqMessage = (dlqOutput.send as any).mock.calls[0][0] as Message;
      expect(dlqMessage.metadata.dlqAttempts).toBe(1);
      expect(dlqMessage.metadata.dlqReason).toContain("bad data");
    });

    it("copies fatal failures to DLQ once then re-fails the original error", async () => {
      let attempts = 0;
      const fatal = new CategorizedTestError("poison", "fatal");
      const mockOutput: Output<Error> = {
        name: "mock-output",
        send: vi.fn().mockReturnValue(
          Effect.suspend(() => {
            attempts++;
            return Effect.fail(fatal);
          }),
        ),
      };
      const dlqOutput: Output<any> = {
        name: "dlq-output",
        send: vi.fn().mockReturnValue(Effect.void),
      };
      const wrappedOutput = withDLQ({
        output: mockOutput,
        dlq: dlqOutput,
        maxRetries: 5,
        retrySchedule: Schedule.spaced(0),
      });

      await expect(
        Effect.runPromise(wrappedOutput.send(createMessage({ test: "data" }))),
      ).rejects.toThrow("poison");

      expect(attempts).toBe(1);
      expect(dlqOutput.send).toHaveBeenCalledTimes(1);
      const dlqMessage = (dlqOutput.send as any).mock.calls[0][0] as Message;
      expect(dlqMessage.metadata.dlqAttempts).toBe(1);
    });

    it("propagates a fatal DLQ send error instead of the primary logical error", async () => {
      let attempts = 0;
      const primary = new CategorizedTestError("bad data", "logical");
      const dlqFatal = new CategorizedTestError("dlq unavailable", "fatal");
      const mockOutput: Output<Error> = {
        name: "mock-output",
        send: vi.fn().mockReturnValue(
          Effect.suspend(() => {
            attempts++;
            return Effect.fail(primary);
          }),
        ),
      };
      const dlqOutput: Output<Error> = {
        name: "dlq-output",
        send: vi.fn().mockReturnValue(Effect.fail(dlqFatal)),
      };
      const wrappedOutput = withDLQ({
        output: mockOutput,
        dlq: dlqOutput,
        maxRetries: 5,
        retrySchedule: Schedule.spaced(0),
      });

      const exit = await Effect.runPromiseExit(
        wrappedOutput.send(createMessage({ test: "data" })),
      );

      expect(attempts).toBe(1);
      expect(dlqOutput.send).toHaveBeenCalledTimes(1);
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(exit.cause._tag).toBe("Fail");
        if (exit.cause._tag === "Fail") {
          expect(exit.cause.error).toBe(dlqFatal);
          expect(exit.cause.error).not.toBe(primary);
        }
      }
    });

    it("keeps the original primary error when DLQ send fails nonfatally", async () => {
      let attempts = 0;
      const primary = new CategorizedTestError("flaky", "intermittent");
      const dlqLogical = new CategorizedTestError("dlq full", "logical");
      const mockOutput: Output<Error> = {
        name: "mock-output",
        send: vi.fn().mockReturnValue(
          Effect.suspend(() => {
            attempts++;
            return Effect.fail(primary);
          }),
        ),
      };
      const dlqOutput: Output<Error> = {
        name: "dlq-output",
        send: vi.fn().mockReturnValue(Effect.fail(dlqLogical)),
      };
      const wrappedOutput = withDLQ({
        output: mockOutput,
        dlq: dlqOutput,
        maxRetries: 1,
        retrySchedule: Schedule.spaced(0),
      });

      const exit = await Effect.runPromiseExit(
        wrappedOutput.send(createMessage({ test: "data" })),
      );

      expect(attempts).toBe(2);
      expect(dlqOutput.send).toHaveBeenCalledTimes(1);
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(exit.cause._tag).toBe("Fail");
        if (exit.cause._tag === "Fail") {
          expect(exit.cause.error).toBe(primary);
          expect(exit.cause.error).not.toBe(dlqLogical);
        }
      }
    });

    it("should close both primary and DLQ outputs", async () => {
      const mockOutput: Output<Error> = {
        name: "mock-output",
        send: vi.fn().mockReturnValue(Effect.void),
        close: vi.fn().mockReturnValue(Effect.void),
      };
      const dlqOutput: Output<any> = {
        name: "dlq-output",
        send: vi.fn().mockReturnValue(Effect.void),
        close: vi.fn().mockReturnValue(Effect.void),
      };

      const wrappedOutput = withDLQ({
        output: mockOutput,
        dlq: dlqOutput,
      });

      expect(wrappedOutput.close).toBeDefined();
      expect(mockOutput.close).not.toHaveBeenCalled();
      expect(dlqOutput.close).not.toHaveBeenCalled();

      if (wrappedOutput.close) {
        await Effect.runPromise(wrappedOutput.close());
        expect(mockOutput.close).toHaveBeenCalledTimes(1);
        expect(dlqOutput.close).toHaveBeenCalledTimes(1);
      }
    });

    it("waits for the DLQ output to close when the primary close fails", async () => {
      const primaryError = new Error("primary close failed");
      let dlqClosed = false;
      const mockOutput: Output<Error> = {
        name: "mock-output",
        send: vi.fn().mockReturnValue(Effect.void),
        close: vi.fn().mockReturnValue(Effect.fail(primaryError)),
      };
      const dlqOutput: Output<Error> = {
        name: "dlq-output",
        send: vi.fn().mockReturnValue(Effect.void),
        close: vi
          .fn()
          .mockReturnValue(
            Effect.sleep("20 millis").pipe(
              Effect.tap(() => Effect.sync(() => (dlqClosed = true))),
            ),
          ),
      };

      const wrappedOutput = withDLQ({
        output: mockOutput,
        dlq: dlqOutput,
      });

      await expect(Effect.runPromise(wrappedOutput.close!())).rejects.toThrow(
        "primary close failed",
      );
      expect(dlqClosed).toBe(true);
      expect(dlqOutput.close).toHaveBeenCalledOnce();
    });

    it("should expose no close method when neither output needs cleanup", () => {
      const wrappedOutput = withDLQ({
        output: {
          name: "mock-output",
          send: vi.fn().mockReturnValue(Effect.void),
        },
        dlq: {
          name: "dlq-output",
          send: vi.fn().mockReturnValue(Effect.void),
        },
      });

      expect(wrappedOutput.close).toBeUndefined();
    });
  });

  describe("getDLQOutput accessor", () => {
    it("exposes the configured raw DLQ and forwards through withBackpressure", () => {
      const primary: Output = {
        name: "primary",
        send: () => Effect.void,
      };
      const dlq: Output = {
        name: "raw-dlq",
        send: () => Effect.void,
      };

      const wrapped = withDLQ({ output: primary, dlq, maxRetries: 0 });
      expect(wrapped.getDLQOutput?.()).toBe(dlq);

      const withoutDlq = withDLQ({ output: primary, maxRetries: 0 });
      expect(withoutDlq.getDLQOutput).toBeUndefined();

      const pressurized = withBackpressure({ output: wrapped });
      expect(pressurized.getDLQOutput?.()).toBe(dlq);
    });

    it("routes terminal processor failures for programmatic create({ output: withDLQ(...) })", async () => {
      const primarySends: Message[] = [];
      const dlqSends: Message[] = [];
      let acked = false;

      const primary: Output = {
        name: "primary-capture",
        send: (msg) =>
          Effect.sync(() => {
            primarySends.push(msg);
          }),
      };
      const dlq: Output = {
        name: "dlq-capture",
        send: (msg) =>
          Effect.sync(() => {
            dlqSends.push(msg);
          }),
      };

      const inputMessage: Message = {
        ...createMessage({ orderId: "order-1" }, { source: "programmatic-dlq" }),
        ack: () =>
          Effect.sync(() => {
            acked = true;
          }),
      };

      const pipeline = create({
        name: "programmatic-withdlq-processor-failure",
        input: {
          name: "one",
          stream: Stream.make(inputMessage),
        },
        processors: [
          {
            name: "always-fail",
            process: () => Effect.fail(new Error("processor boom")),
          },
        ],
        output: withDLQ({
          output: primary,
          dlq,
          maxRetries: 0,
        }),
      });

      const result = await Effect.runPromise(run(pipeline));

      expect(primarySends).toHaveLength(0);
      expect(dlqSends).toHaveLength(1);
      expect(acked).toBe(false);
      expect(result.stats.failed).toBe(1);
      expect(result.stats.processed).toBe(0);

      const dlqMessage = dlqSends[0];
      expect(dlqMessage.id).toBe(inputMessage.id);
      expect(dlqMessage.content).toEqual({ orderId: "order-1" });
      expect(dlqMessage.metadata.source).toBe("programmatic-dlq");
      expect(dlqMessage.metadata.dlq).toBe(true);
      expect(dlqMessage.metadata.originalMessageId).toBe(inputMessage.id);
      expect(dlqMessage.metadata.dlqAttempts).toBe(1);
      expect(String(dlqMessage.metadata.dlqReason)).toContain("processor boom");
      expect(typeof dlqMessage.metadata.dlqTimestamp).toBe("number");
    });
  });
});
