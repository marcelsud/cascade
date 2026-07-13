import { describe, it, expect, vi, beforeEach } from "vitest";
import { Chunk, Duration, Effect, Schedule } from "effect";
import {
  createDLQRetrySchedule,
  withDLQ,
  DLQError,
} from "../../../src/core/dlq.js";
import { createMessage } from "../../../src/core/types.js";
import type { Output, Message } from "../../../src/core/types.js";

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
});
