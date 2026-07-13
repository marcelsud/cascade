import { describe, it, expect, beforeEach } from "vitest";
import { Effect } from "effect";
import {
  MetricsAccumulator,
  emitInputMetrics,
  emitOutputMetrics,
  measureDuration,
  type InputMetrics,
  type OutputMetrics,
} from "../../../src/core/metrics.js";

describe("Metrics Collection", () => {
  describe("MetricsAccumulator", () => {
    let accumulator: MetricsAccumulator;

    beforeEach(() => {
      accumulator = new MetricsAccumulator("test-component");
    });

    describe("Input metrics", () => {
      it("should initialize with zero values", () => {
        const metrics = accumulator.getInputMetrics();

        expect(metrics.component).toBe("test-component");
        expect(metrics.messagesProcessed).toBe(0);
        expect(metrics.messagesDropped).toBe(0);
        expect(metrics.errorsEncountered).toBe(0);
        expect(metrics.averageDuration).toBe(0);
        expect(metrics.totalDuration).toBe(0);
        expect(metrics.timestamp).toBeGreaterThan(0);
      });

      it("should record processed messages", () => {
        accumulator.recordProcessed(10);
        accumulator.recordProcessed(20);
        accumulator.recordProcessed(30);

        const metrics = accumulator.getInputMetrics();

        expect(metrics.messagesProcessed).toBe(3);
        expect(metrics.totalDuration).toBe(60);
        expect(metrics.averageDuration).toBe(20); // (10 + 20 + 30) / 3
      });

      it("should record errors", () => {
        accumulator.recordError();
        accumulator.recordError();

        const metrics = accumulator.getInputMetrics();

        expect(metrics.errorsEncountered).toBe(2);
      });

      it("should record dropped input messages", () => {
        accumulator.recordDropped();
        accumulator.recordDropped();
        expect(accumulator.getInputMetrics().messagesDropped).toBe(2);
      });

      it("should calculate average duration correctly", () => {
        accumulator.recordProcessed(100);
        accumulator.recordProcessed(200);
        accumulator.recordProcessed(300);

        const metrics = accumulator.getInputMetrics();

        expect(metrics.averageDuration).toBe(200);
      });

      it("should handle zero operations for average", () => {
        const metrics = accumulator.getInputMetrics();

        expect(metrics.averageDuration).toBe(0);
      });
    });

    describe("Output metrics", () => {
      it("should initialize with zero values", () => {
        const metrics = accumulator.getOutputMetrics();

        expect(metrics.component).toBe("test-component");
        expect(metrics.messagesSent).toBe(0);
        expect(metrics.batchesSent).toBe(0);
        expect(metrics.sendErrors).toBe(0);
        expect(metrics.averageDuration).toBe(0);
        expect(metrics.totalDuration).toBe(0);
        expect(metrics.timestamp).toBeGreaterThan(0);
      });

      it("should record sent messages", () => {
        accumulator.recordSent(1, 10);
        accumulator.recordSent(1, 20);
        accumulator.recordSent(1, 30);

        const metrics = accumulator.getOutputMetrics();

        expect(metrics.messagesSent).toBe(3);
        expect(metrics.totalDuration).toBe(60);
        expect(metrics.averageDuration).toBe(20);
      });

      it("should record batches", () => {
        accumulator.recordBatch(5, 100);
        accumulator.recordBatch(10, 200);

        const metrics = accumulator.getOutputMetrics();

        expect(metrics.messagesSent).toBe(15); // 5 + 10
        expect(metrics.batchesSent).toBe(2);
        expect(metrics.totalDuration).toBe(300);
        expect(metrics.averageDuration).toBe(150); // (100 + 200) / 2
      });

      it("should record send errors", () => {
        accumulator.recordSendError();
        accumulator.recordSendError();
        accumulator.recordSendError();

        const metrics = accumulator.getOutputMetrics();

        expect(metrics.sendErrors).toBe(3);
      });

      it("should handle mixed sends and batches", () => {
        accumulator.recordSent(1, 10);
        accumulator.recordBatch(5, 50);
        accumulator.recordSent(1, 20);

        const metrics = accumulator.getOutputMetrics();

        expect(metrics.messagesSent).toBe(7); // 1 + 5 + 1
        expect(metrics.batchesSent).toBe(1);
        expect(metrics.totalDuration).toBe(80);
        expect(metrics.averageDuration).toBe(27); // Math.round(80 / 3)
      });
    });

    describe("reset", () => {
      it("should reset all counters", () => {
        accumulator.recordProcessed(100);
        accumulator.recordSent(5, 50);
        accumulator.recordBatch(10, 200);
        accumulator.recordError();
        accumulator.recordDropped();
        accumulator.recordSendError();

        accumulator.reset();

        const inputMetrics = accumulator.getInputMetrics();
        const outputMetrics = accumulator.getOutputMetrics();

        expect(inputMetrics.messagesProcessed).toBe(0);
        expect(inputMetrics.messagesDropped).toBe(0);
        expect(inputMetrics.errorsEncountered).toBe(0);
        expect(inputMetrics.totalDuration).toBe(0);

        expect(outputMetrics.messagesSent).toBe(0);
        expect(outputMetrics.batchesSent).toBe(0);
        expect(outputMetrics.sendErrors).toBe(0);
        expect(outputMetrics.totalDuration).toBe(0);
      });
    });
  });

  describe("emitInputMetrics", () => {
    it("should emit structured metrics via Effect logging", async () => {
      const metrics: InputMetrics = {
        component: "test-input",
        timestamp: Date.now(),
        messagesProcessed: 127,
        messagesDropped: 4,
        errorsEncountered: 3,
        averageDuration: 145,
        totalDuration: 1000,
      };

      // Should not throw
      await Effect.runPromise(emitInputMetrics(metrics));
    });
  });

  describe("emitOutputMetrics", () => {
    it("should emit structured metrics via Effect logging", async () => {
      const metrics: OutputMetrics = {
        component: "test-output",
        timestamp: Date.now(),
        messagesSent: 250,
        batchesSent: 25,
        sendErrors: 2,
        averageDuration: 50,
        totalDuration: 1250,
      };

      // Should not throw
      await Effect.runPromise(emitOutputMetrics(metrics));
    });
  });

  describe("measureDuration", () => {
    it("should measure effect execution duration", async () => {
      const effect = Effect.gen(function* () {
        yield* Effect.sleep("10 millis");
        return "result";
      });

      const [result, duration] = await Effect.runPromise(
        measureDuration(effect),
      );

      expect(result).toBe("result");
      expect(duration).toBeGreaterThanOrEqual(10);
      expect(duration).toBeLessThan(100); // Should be quick
    });

    it("should measure fast effects", async () => {
      const effect = Effect.succeed(42);

      const [result, duration] = await Effect.runPromise(
        measureDuration(effect),
      );

      expect(result).toBe(42);
      expect(duration).toBeGreaterThanOrEqual(0);
      expect(duration).toBeLessThan(10);
    });

    it("should propagate errors", async () => {
      const effect = Effect.fail(new Error("test error"));

      await expect(Effect.runPromise(measureDuration(effect))).rejects.toThrow(
        "test error",
      );
    });

    it("should measure duration even on errors", async () => {
      const effect = Effect.gen(function* () {
        yield* Effect.sleep("20 millis");
        return yield* Effect.fail(new Error("delayed error"));
      });

      try {
        await Effect.runPromise(measureDuration(effect));
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe("delayed error");
      }
    });
  });

  describe("Integration scenarios", () => {
    it("should track complete input processing cycle", () => {
      const metrics = new MetricsAccumulator("integration-input");

      // Process batch of messages
      for (let i = 0; i < 50; i++) {
        metrics.recordProcessed(10 + i); // Increasing durations
      }

      // Some errors occurred
      metrics.recordError();
      metrics.recordError();

      const snapshot = metrics.getInputMetrics();

      expect(snapshot.messagesProcessed).toBe(50);
      expect(snapshot.errorsEncountered).toBe(2);
      expect(snapshot.totalDuration).toBe(1725); // Sum of 10..59 = (10+59)*50/2
      expect(snapshot.averageDuration).toBe(35); // Math.round(1725 / 50)
    });

    it("should track complete output processing cycle", () => {
      const metrics = new MetricsAccumulator("integration-output");

      // Send some individual messages
      metrics.recordSent(1, 10);
      metrics.recordSent(1, 15);

      // Send batches
      metrics.recordBatch(10, 100);
      metrics.recordBatch(20, 200);

      // Some send errors
      metrics.recordSendError();

      const snapshot = metrics.getOutputMetrics();

      expect(snapshot.messagesSent).toBe(32); // 1 + 1 + 10 + 20
      expect(snapshot.batchesSent).toBe(2);
      expect(snapshot.sendErrors).toBe(1);
      expect(snapshot.totalDuration).toBe(325); // 10 + 15 + 100 + 200
      expect(snapshot.averageDuration).toBe(81); // Math.round(325 / 4)
    });

    it("should handle periodic metrics emission pattern", () => {
      const metrics = new MetricsAccumulator("periodic-test");
      let emissionCount = 0;
      const threshold = 100;

      for (let i = 0; i < 250; i++) {
        metrics.recordProcessed(5);

        // Simulate emitting every 100 messages
        if ((i + 1) % threshold === 0) {
          const snapshot = metrics.getInputMetrics();
          expect(snapshot.messagesProcessed).toBe(
            threshold * (emissionCount + 1),
          );
          emissionCount++;
        }
      }

      expect(emissionCount).toBe(2); // At 100 and 200
      expect(metrics.getInputMetrics().messagesProcessed).toBe(250);
    });
  });
});
