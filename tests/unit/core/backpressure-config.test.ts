import { afterEach, describe, expect, it } from "vitest";
import { Deferred, Effect, Either, Exit, Schedule } from "effect";
import * as S from "effect/Schema";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as yaml from "yaml";
import {
  loadConfig,
  PipelineConfigSchema,
} from "../../../src/core/config-loader.js";
import { withBackpressure, withDLQ } from "../../../src/core/dlq.js";
import {
  ComponentError,
  type ErrorCategory,
} from "../../../src/core/errors.js";
import { buildPipeline } from "../../../src/core/pipeline-builder.js";
import { run } from "../../../src/core/pipeline.js";
import type { Message, Output } from "../../../src/core/types.js";

class CategorizedTestError extends ComponentError {
  readonly _tag = "CategorizedTestError";
  constructor(
    message: string,
    readonly category: ErrorCategory,
  ) {
    super(message);
  }
}

const baseConfig = {
  input: {
    generate: {
      count: 1,
      template: { value: "test" },
    },
  },
  output: {
    capture: {},
  },
};

const tempDirs: string[] = [];

const loadYamlConfig = async (config: unknown) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cascade-config-"));
  tempDirs.push(dir);
  const configPath = path.join(dir, "config.yaml");
  await fs.writeFile(configPath, yaml.stringify(config), "utf8");
  return Effect.runPromise(Effect.either(loadConfig(configPath)));
};

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true })),
  );
});

describe("pipeline backpressure configuration", () => {
  it("maps YAML-style fields to the runtime pipeline", async () => {
    const config = await Effect.runPromise(
      S.decodeUnknown(PipelineConfigSchema)({
        ...baseConfig,
        pipeline: {
          backpressure: {
            max_concurrent_messages: 12,
            max_concurrent_outputs: 4,
          },
        },
      }),
    );

    const pipeline = await Effect.runPromise(buildPipeline(config));

    expect(pipeline.backpressure).toEqual({
      maxConcurrentMessages: 12,
      maxConcurrentOutputs: 4,
    });
  });

  it("leaves backpressure unset when it is not configured", async () => {
    const config = await Effect.runPromise(
      S.decodeUnknown(PipelineConfigSchema)(baseConfig),
    );

    const pipeline = await Effect.runPromise(buildPipeline(config));

    expect(pipeline.backpressure).toBeUndefined();
  });

  it("uses the runtime output concurrency default for partial config", async () => {
    const config = await Effect.runPromise(
      S.decodeUnknown(PipelineConfigSchema)({
        ...baseConfig,
        pipeline: {
          backpressure: {
            max_concurrent_messages: 12,
          },
        },
      }),
    );

    const pipeline = await Effect.runPromise(buildPipeline(config));

    expect(pipeline.backpressure).toEqual({
      maxConcurrentMessages: 12,
      maxConcurrentOutputs: undefined,
    });

    let activeOutputs = 0;
    let maxActiveOutputs = 0;
    const result = await Effect.runPromise(
      run({
        ...pipeline,
        processors: [
          {
            name: "fan-out",
            process: (message) =>
              Effect.succeed(
                Array.from({ length: 10 }, (_, index) => ({
                  ...message,
                  id: `${message.id}-${index}`,
                })),
              ),
          },
        ],
        output: {
          name: "concurrency-probe",
          send: () =>
            Effect.gen(function* () {
              activeOutputs += 1;
              maxActiveOutputs = Math.max(maxActiveOutputs, activeOutputs);
              yield* Effect.sleep("10 millis");
              activeOutputs -= 1;
            }),
        },
      }),
    );

    expect(result.success).toBe(true);
    expect(maxActiveOutputs).toBe(5);
  });

  it("caps simultaneous primary sends across concurrent one-to-one workers", async () => {
    const config = await Effect.runPromise(
      S.decodeUnknown(PipelineConfigSchema)({
        input: {
          generate: {
            count: 10,
            template: { value: "test" },
          },
        },
        output: {
          capture: {},
        },
        pipeline: {
          backpressure: {
            max_concurrent_messages: 10,
            max_concurrent_outputs: 2,
          },
        },
      }),
    );

    const pipeline = await Effect.runPromise(buildPipeline(config));

    let activeOutputs = 0;
    let maxActiveOutputs = 0;
    const result = await Effect.runPromise(
      run({
        ...pipeline,
        output: {
          name: "concurrency-probe",
          send: () =>
            Effect.gen(function* () {
              activeOutputs += 1;
              maxActiveOutputs = Math.max(maxActiveOutputs, activeOutputs);
              yield* Effect.sleep("20 millis");
              activeOutputs -= 1;
            }),
        },
      }),
    );

    expect(result.success).toBe(true);
    expect(result.stats.processed).toBe(10);
    expect(maxActiveOutputs).toBe(2);
  });

  it("caps aggregate fan-out sends across multiple source-message workers", async () => {
    const config = await Effect.runPromise(
      S.decodeUnknown(PipelineConfigSchema)({
        input: {
          generate: {
            count: 2,
            template: { value: "test" },
          },
        },
        output: {
          capture: {},
        },
        pipeline: {
          backpressure: {
            max_concurrent_messages: 2,
            max_concurrent_outputs: 2,
          },
        },
      }),
    );

    const pipeline = await Effect.runPromise(buildPipeline(config));

    let activeOutputs = 0;
    let maxActiveOutputs = 0;
    const result = await Effect.runPromise(
      run({
        ...pipeline,
        processors: [
          {
            name: "fan-out",
            process: (message) =>
              Effect.succeed(
                Array.from({ length: 4 }, (_, index) => ({
                  ...message,
                  id: `${message.id}-${index}`,
                })),
              ),
          },
        ],
        output: {
          name: "concurrency-probe",
          send: () =>
            Effect.gen(function* () {
              activeOutputs += 1;
              maxActiveOutputs = Math.max(maxActiveOutputs, activeOutputs);
              yield* Effect.sleep("20 millis");
              activeOutputs -= 1;
            }),
        },
      }),
    );

    expect(result.success).toBe(true);
    expect(result.stats.processed).toBe(8);
    expect(maxActiveOutputs).toBe(2);
  });

  it("enforces the default output concurrency globally across source messages", async () => {
    const config = await Effect.runPromise(
      S.decodeUnknown(PipelineConfigSchema)({
        input: {
          generate: {
            count: 10,
            template: { value: "test" },
          },
        },
        output: {
          capture: {},
        },
      }),
    );

    const pipeline = await Effect.runPromise(buildPipeline(config));

    let activeOutputs = 0;
    let maxActiveOutputs = 0;
    const result = await Effect.runPromise(
      run({
        ...pipeline,
        backpressure: {
          maxConcurrentMessages: 10,
        },
        output: {
          name: "concurrency-probe",
          send: () =>
            Effect.gen(function* () {
              activeOutputs += 1;
              maxActiveOutputs = Math.max(maxActiveOutputs, activeOutputs);
              yield* Effect.sleep("20 millis");
              activeOutputs -= 1;
            }),
        },
      }),
    );

    expect(result.success).toBe(true);
    expect(result.stats.processed).toBe(10);
    expect(maxActiveOutputs).toBe(5);
  });

  it("keeps max_concurrent_messages independent of the output cap", async () => {
    const config = await Effect.runPromise(
      S.decodeUnknown(PipelineConfigSchema)({
        input: {
          generate: {
            count: 6,
            template: { value: "test" },
          },
        },
        output: {
          capture: {},
        },
        pipeline: {
          backpressure: {
            max_concurrent_messages: 3,
            max_concurrent_outputs: 1,
          },
        },
      }),
    );

    const pipeline = await Effect.runPromise(buildPipeline(config));

    let activeProcessors = 0;
    let maxActiveProcessors = 0;
    let activeOutputs = 0;
    let maxActiveOutputs = 0;

    const result = await Effect.runPromise(
      run({
        ...pipeline,
        processors: [
          {
            name: "processor-probe",
            process: (message) =>
              Effect.gen(function* () {
                activeProcessors += 1;
                maxActiveProcessors = Math.max(
                  maxActiveProcessors,
                  activeProcessors,
                );
                yield* Effect.sleep("30 millis");
                activeProcessors -= 1;
                return [message];
              }),
          },
        ],
        output: {
          name: "concurrency-probe",
          send: () =>
            Effect.gen(function* () {
              activeOutputs += 1;
              maxActiveOutputs = Math.max(maxActiveOutputs, activeOutputs);
              yield* Effect.sleep("5 millis");
              activeOutputs -= 1;
            }),
        },
      }),
    );

    expect(result.success).toBe(true);
    expect(result.stats.processed).toBe(6);
    expect(maxActiveOutputs).toBe(1);
    // Output cap of 1 must not serialize processors down to 1.
    expect(maxActiveProcessors).toBe(3);
  });

  it("releases primary output permits before DLQ routing", async () => {
    const config = await Effect.runPromise(
      S.decodeUnknown(PipelineConfigSchema)({
        input: {
          generate: {
            count: 2,
            template: { value: "test" },
          },
        },
        output: {
          capture: {},
        },
        pipeline: {
          backpressure: {
            max_concurrent_messages: 2,
            max_concurrent_outputs: 1,
          },
        },
      }),
    );

    const pipeline = await Effect.runPromise(buildPipeline(config));

    let primaryStarts = 0;
    let dlqStarts = 0;
    const secondPrimaryStarted = await Effect.runPromise(Deferred.make<void>());

    const primary: Output = {
      name: "primary-fail-first",
      send: () =>
        Effect.suspend(() => {
          primaryStarts += 1;
          const attempt = primaryStarts;
          if (attempt === 1) {
            return Effect.fail(
              new CategorizedTestError("primary unavailable", "logical"),
            );
          }
          return Deferred.succeed(secondPrimaryStarted, undefined).pipe(
            Effect.asVoid,
          );
        }),
    };

    const dlq: Output = {
      name: "dlq-waits-for-second-primary",
      send: () =>
        Effect.gen(function* () {
          dlqStarts += 1;
          // Completes only after another primary send starts — deadlocks if
          // the failed primary still holds the sole output permit.
          yield* Deferred.await(secondPrimaryStarted);
        }),
    };

    const result = await Effect.runPromise(
      run({
        ...pipeline,
        output: withDLQ({
          output: primary,
          dlq,
          maxRetries: 0,
          retrySchedule: Schedule.spaced(0),
        }),
      }).pipe(Effect.timeout("500 millis"), Effect.exit),
    );

    expect(Exit.isSuccess(result)).toBe(true);
    if (Exit.isSuccess(result)) {
      expect(result.value.success).toBe(true);
      expect(result.value.stats.processed).toBe(2);
    }
    expect(primaryStarts).toBe(2);
    expect(dlqStarts).toBe(1);
  });

  it("does not hold a primary permit across withDLQ retry backoff", async () => {
    // Direct wrapper probe: with only one permit, a second primary send must
    // be able to start during the first message's retry Schedule delay.
    const permits = await Effect.runPromise(Effect.makeSemaphore(1));
    const startOrder: string[] = [];
    const attemptsByMessage = new Map<string, number>();

    const primary: Output = {
      name: "primary-retry-probe",
      send: (msg: Message) =>
        Effect.suspend(() => {
          startOrder.push(msg.id);
          const attempt = (attemptsByMessage.get(msg.id) ?? 0) + 1;
          attemptsByMessage.set(msg.id, attempt);
          if (msg.id === "a" && attempt === 1) {
            return Effect.fail(
              new CategorizedTestError("transient", "intermittent"),
            );
          }
          return Effect.void;
        }),
    };

    const bound = withDLQ({
      output: primary,
      maxRetries: 1,
      retrySchedule: Schedule.spaced("150 millis"),
    }).bindPrimaryOutputPermits!(permits);

    const msgA = {
      id: "a",
      content: { value: "a" },
      metadata: {},
      timestamp: Date.now(),
    } satisfies Message;
    const msgB = {
      id: "b",
      content: { value: "b" },
      metadata: {},
      timestamp: Date.now(),
    } satisfies Message;

    // Stagger B slightly so A fails and enters backoff first; B must still
    // acquire the sole permit before A's retry (prove release-before-backoff).
    const result = await Effect.runPromise(
      Effect.all(
        [
          bound.send(msgA),
          Effect.sleep("20 millis").pipe(Effect.zipRight(bound.send(msgB))),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.timeout("1 second"), Effect.exit),
    );

    expect(Exit.isSuccess(result)).toBe(true);
    expect(startOrder).toEqual(["a", "b", "a"]);
  });

  it("does not double-wrap when binder omits bindPrimaryOutputPermits on bound copy", async () => {
    // A conforming binder may return an already-guarded Output without
    // re-exposing bindPrimaryOutputPermits. The runner must decide outer
    // wrap from whether the original output had a binder, not the bound copy.
    const config = await Effect.runPromise(
      S.decodeUnknown(PipelineConfigSchema)({
        input: {
          generate: {
            count: 1,
            template: { value: "test" },
          },
        },
        output: {
          capture: {},
        },
        pipeline: {
          backpressure: {
            max_concurrent_messages: 1,
            max_concurrent_outputs: 1,
          },
        },
      }),
    );

    const pipeline = await Effect.runPromise(buildPipeline(config));

    let primaryStarts = 0;
    const primary: Output = {
      name: "binder-omits-method",
      send: () =>
        Effect.sync(() => {
          primaryStarts += 1;
        }),
      bindPrimaryOutputPermits: (permits) => ({
        name: "binder-omits-method-bound",
        send: (msg: Message) => permits.withPermits(1)(primary.send(msg)),
        // Intentionally omit bindPrimaryOutputPermits on the bound copy.
      }),
    };

    const result = await Effect.runPromise(
      run({
        ...pipeline,
        output: primary,
      }).pipe(Effect.timeout("500 millis"), Effect.exit),
    );

    expect(Exit.isSuccess(result)).toBe(true);
    if (Exit.isSuccess(result)) {
      expect(result.value.success).toBe(true);
      expect(result.value.stats.processed).toBe(1);
    }
    expect(primaryStarts).toBe(1);
  });

  it("preserves binder this when binding primary output permits", async () => {
    // Extracting bindPrimaryOutputPermits into a free function drops the
    // receiver. A type-conforming method binder that reads `this.name` must
    // still complete one send; silent success with processed:0 is a hard failure.
    const config = await Effect.runPromise(
      S.decodeUnknown(PipelineConfigSchema)({
        input: {
          generate: {
            count: 1,
            template: { value: "test" },
          },
        },
        output: {
          capture: {},
        },
        pipeline: {
          backpressure: {
            max_concurrent_messages: 1,
            max_concurrent_outputs: 1,
          },
        },
      }),
    );

    const pipeline = await Effect.runPromise(buildPipeline(config));

    let sends = 0;
    const output: Output = {
      name: "receiver-aware",
      send() {
        sends += 1;
        return Effect.void;
      },
      bindPrimaryOutputPermits(permits) {
        // Method form reads the receiver. Optional-chain only so a lost
        // `this` still returns a binder copy; the subsequent self.send call
        // then defects and the run reports success with processed:0.
        const self = this;
        return {
          name: `${this?.name}-bound`,
          send(msg: Message) {
            return permits.withPermits(1)(self.send(msg));
          },
          bindPrimaryOutputPermits: this?.bindPrimaryOutputPermits,
        };
      },
    };

    const result = await Effect.runPromise(
      run({
        ...pipeline,
        output,
      }).pipe(Effect.timeout("500 millis"), Effect.exit),
    );

    expect(Exit.isSuccess(result)).toBe(true);
    if (Exit.isSuccess(result)) {
      expect(result.value.success).toBe(true);
      expect(result.value.stats.processed).toBe(1);
    }
    expect(sends).toBe(1);
  });

  it("recursively binds nested permit-aware wrappers under withDLQ", async () => {
    // Outer withDLQ must not hold the sole primary permit across an inner
    // wrapper's own DLQ routing. Nested shape:
    //   withDLQ(withBackpressure(withDLQ(primary, dlq)))
    const config = await Effect.runPromise(
      S.decodeUnknown(PipelineConfigSchema)({
        input: {
          generate: {
            count: 2,
            template: { value: "test" },
          },
        },
        output: {
          capture: {},
        },
        pipeline: {
          backpressure: {
            max_concurrent_messages: 2,
            max_concurrent_outputs: 1,
          },
        },
      }),
    );

    const pipeline = await Effect.runPromise(buildPipeline(config));

    let primaryStarts = 0;
    let dlqStarts = 0;
    const secondPrimaryStarted = await Effect.runPromise(Deferred.make<void>());

    const primary: Output = {
      name: "nested-primary-fail-first",
      send: () =>
        Effect.suspend(() => {
          primaryStarts += 1;
          const attempt = primaryStarts;
          if (attempt === 1) {
            return Effect.fail(
              new CategorizedTestError("primary unavailable", "logical"),
            );
          }
          return Deferred.succeed(secondPrimaryStarted, undefined).pipe(
            Effect.asVoid,
          );
        }),
    };

    const dlq: Output = {
      name: "nested-dlq-waits-for-second-primary",
      send: () =>
        Effect.gen(function* () {
          dlqStarts += 1;
          // Completes only after another primary send starts — deadlocks if
          // the outer withDLQ still holds the sole output permit during DLQ.
          yield* Deferred.await(secondPrimaryStarted);
        }),
    };

    const nested = withDLQ({
      output: withBackpressure({
        output: withDLQ({
          output: primary,
          dlq,
          maxRetries: 0,
          retrySchedule: Schedule.spaced(0),
        }),
      }),
      maxRetries: 0,
      retrySchedule: Schedule.spaced(0),
    });

    const result = await Effect.runPromise(
      run({
        ...pipeline,
        output: nested,
      }).pipe(Effect.timeout("500 millis"), Effect.exit),
    );

    expect(Exit.isSuccess(result)).toBe(true);
    if (Exit.isSuccess(result)) {
      expect(result.value.success).toBe(true);
      expect(result.value.stats.processed).toBe(2);
    }
    expect(primaryStarts).toBe(2);
    expect(dlqStarts).toBe(1);
  });

  it("collapses an empty backpressure object to undefined", async () => {
    const config = await Effect.runPromise(
      S.decodeUnknown(PipelineConfigSchema)({
        ...baseConfig,
        pipeline: { backpressure: {} },
      }),
    );

    const pipeline = await Effect.runPromise(buildPipeline(config));

    expect(pipeline.backpressure).toBeUndefined();
  });

  it("rejects misplaced top-level processors when loading YAML", async () => {
    const result = await loadYamlConfig({
      ...baseConfig,
      processors: [{ log: { level: "info" } }],
    });

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.message).toContain('is unexpected, expected: "input"');
    }
  });

  it("rejects typos in the backpressure envelope", async () => {
    const result = await loadYamlConfig({
      ...baseConfig,
      pipeline: {
        backpressure: { max_concurent_messages: 12 },
      },
    });

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.message).toContain("max_concurent_messages");
      expect(result.left.message).toContain("is unexpected");
    }
  });

  it.each([
    ["max_concurrent_messages=0", "max_concurrent_messages", 0],
    ["max_concurrent_messages=-1", "max_concurrent_messages", -1],
    ["max_concurrent_messages=1.5", "max_concurrent_messages", 1.5],
    ["max_concurrent_outputs=0", "max_concurrent_outputs", 0],
    ["max_concurrent_outputs=-1", "max_concurrent_outputs", -1],
    ["max_concurrent_outputs=1.5", "max_concurrent_outputs", 1.5],
  ])("rejects invalid %s", async (_, field, value) => {
    const result = await Effect.runPromise(
      Effect.either(
        S.decodeUnknown(PipelineConfigSchema)({
          ...baseConfig,
          pipeline: {
            backpressure: {
              [field]: value,
            },
          },
        }),
      ),
    );

    expect(Either.isLeft(result)).toBe(true);
  });
});
