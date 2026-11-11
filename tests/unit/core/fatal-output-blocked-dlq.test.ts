import { describe, expect, it, vi } from "vitest";
import { Effect, Option, Stream } from "effect";
import { withDLQ } from "../../../src/core/dlq.js";
import {
  ComponentError,
  type ErrorCategory,
} from "../../../src/core/errors.js";
import { run } from "../../../src/core/pipeline.js";
import { createMessage, type Message } from "../../../src/core/types.js";

class CategorizedFailure extends ComponentError {
  readonly _tag = "CategorizedFailure";
  constructor(
    message: string,
    readonly category: ErrorCategory,
  ) {
    super(message);
  }
}

describe("fatal primary output with blocked DLQ", () => {
  it.each(["pipeline", "run override"])(
    "bounds fatal archival with the %s shutdown budget",
    async (budgetSource) => {
      const fatal = new CategorizedFailure(
        "primary destination failed fatally",
        "fatal",
      );
      const ack = vi.fn(() => Effect.void);
      const inputClose = vi.fn(() => Effect.void);
      const primaryClose = vi.fn(() => Effect.void);
      const dlqClose = vi.fn(() => Effect.void);
      let interrupted = false;
      const dlqSend = vi.fn((_message: Message) =>
        Effect.never.pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              interrupted = true;
            }),
          ),
        ),
      );
      const original = { ...createMessage({ value: "recover me" }), ack };
      const result = await Effect.runPromise(
        run(
          {
            name: "fatal-output-blocked-dlq",
            input: {
              name: "one",
              stream: Stream.make(original),
              close: inputClose,
            },
            processors: [],
            output: withDLQ({
              output: {
                name: "fatal-primary",
                send: () => Effect.fail(fatal),
                close: primaryClose,
              },
              dlq: { name: "blocked-dlq", send: dlqSend, close: dlqClose },
              maxRetries: 0,
            }),
            shutdownTimeoutMs: budgetSource === "pipeline" ? 25 : 10_000,
          },
          budgetSource === "run override" ? { shutdownTimeoutMs: 25 } : {},
        ).pipe(Effect.timeoutOption("300 millis")),
      );
      expect(
        Option.isSome(result),
        "fatal halt must not wait indefinitely for DLQ archival",
      ).toBe(true);
      if (Option.isSome(result)) {
        expect(result.value.success).toBe(false);
        expect(result.value.stats.failed).toBe(1);
        expect(result.value.stats.processed).toBe(0);
        // Effect annotates failures with a span Proxy. Preserve the original
        // typed diagnostic, rather than requiring reference identity.
        expect(
          result.value.errors?.some(
            (error) =>
              error instanceof CategorizedFailure &&
              error.category === "fatal" &&
              error.message === fatal.message,
          ),
        ).toBe(true);
      }
      expect(dlqSend).toHaveBeenCalledOnce();
      expect(dlqSend.mock.calls[0][0]).toMatchObject({
        id: original.id,
        content: original.content,
        metadata: {
          dlq: true,
          dlqReason: fatal.message,
          dlqAttempts: 1,
          originalMessageId: original.id,
        },
      });
      expect(ack).not.toHaveBeenCalled();
      expect(interrupted).toBe(true);
      expect(inputClose).toHaveBeenCalledOnce();
      expect(primaryClose).toHaveBeenCalledOnce();
      expect(dlqClose).toHaveBeenCalledOnce();
    },
  );

  it.each(["logical", "intermittent"] as const)(
    "preserves %s archival even when it exceeds the fatal-copy budget",
    async (category) => {
      const failure = new CategorizedFailure(
        "nonfatal delivery failed",
        category,
      );
      const ack = vi.fn(() => Effect.void);
      const archived: Message[] = [];
      const result = await Effect.runPromise(
        run({
          name: "nonfatal-dlq-copy",
          input: {
            name: "one",
            stream: Stream.make({ ...createMessage("payload"), ack }),
          },
          processors: [],
          output: withDLQ({
            output: { name: "primary", send: () => Effect.fail(failure) },
            dlq: {
              name: "slow-dlq",
              send: (message) =>
                Effect.sleep("40 millis").pipe(
                  Effect.zipRight(
                    Effect.sync(() => {
                      archived.push(message);
                    }),
                  ),
                ),
            },
            maxRetries: 0,
          }),
          shutdownTimeoutMs: 5,
        }).pipe(Effect.timeout("300 millis")),
      );
      expect(result.success).toBe(true);
      expect(result.stats.processed).toBe(1);
      expect(result.stats.failed).toBe(0);
      expect(archived).toHaveLength(1);
      expect(ack).toHaveBeenCalledOnce();
    },
  );
});
