/**
 * Core types and interfaces for the pipeline system
 */
import { Effect, Stream } from "effect";
import type { InputMetrics, OutputMetrics } from "./metrics.js";

/**
 * Message flowing through the pipeline
 * Contains content, metadata, and tracing information
 */
export interface Message<A = unknown> {
  readonly id: string;
  readonly content: A;
  readonly metadata: Record<string, unknown>;
  readonly timestamp: number;
  /** Mark the source message as handled after all downstream sends succeed. */
  readonly ack?: () => Effect.Effect<void, unknown>;
  readonly correlationId?: string;
  readonly trace?: {
    readonly spanId: string;
    readonly traceId: string;
  };
}

/**
 * Input produces a Stream of messages
 * Responsible for consuming from external sources (SQS, Kafka, HTTP, etc.)
 */
export interface Input<E = never, R = never> {
  readonly name: string;
  readonly stream: Stream.Stream<Message, E, R>;
  /** Finish a destructive pull already in progress before stopping intake. */
  readonly shutdownMode?: "interrupt" | "finish-current";
  readonly close?: () => Effect.Effect<void, never, never>;
  readonly getMetrics?: () => InputMetrics;
}

/**
 * Processor transforms messages
 * Can produce one or multiple messages from a single input
 */
export interface Processor<E = never, R = never> {
  readonly name: string;
  readonly process: (msg: Message) => Effect.Effect<Message | Message[], E, R>;
}

/**
 * Output consumes messages and sends them to external systems
 * Responsible for writing to destinations (Redis, Postgres, HTTP, etc.)
 */
export interface Output<E = never, R = never> {
  readonly name: string;
  readonly send: (msg: Message) => Effect.Effect<void, E, R>;
  /** Flush buffered data and release resources, surfacing delivery failures. */
  readonly close?: () => Effect.Effect<void, E, R>;
  readonly getMetrics?: () => OutputMetrics;
  /** Metrics for a distinct DLQ destination wrapped around this output. */
  readonly getDLQMetrics?: () => OutputMetrics;
  /**
   * Raw DLQ destination configured by a wrapper such as withDLQ.
   * Lifecycle-observation/routing only — never closed separately;
   * pipeline.output remains the sole close owner.
   */
  readonly getDLQOutput?: () => Output<E, R> | undefined;
  /**
   * When present, returns a copy of this output (and nested wrappers) that
   * takes from `permits` around each underlying primary send attempt only.
   * Retry backoff and DLQ routing must not hold a primary permit.
   */
  readonly bindPrimaryOutputPermits?: (
    permits: Effect.Semaphore,
  ) => Output<E, R>;
}

/**
 * Backpressure configuration for pipeline execution
 */
export interface BackpressureConfig {
  readonly maxConcurrentMessages?: number; // Max concurrent message processing (default: 10)
  readonly maxConcurrentOutputs?: number; // Max concurrent output sends (default: 5)
}

/**
 * Pipeline configuration combining input, processors, and output
 */
export interface Pipeline<E = never, R = never> {
  readonly name: string;
  readonly input: Input<E, R>;
  readonly processors: ReadonlyArray<Processor<E, R>>;
  readonly output: Output<E, R>;
  /**
   * Unwrapped primary destination when buildPipeline installs withDLQ.
   * Observation-only — pipeline.output remains the sole close owner.
   */
  readonly primaryOutput?: Output<E, R>;
  /**
   * DLQ destination for terminal failures.
   * Pipeline routes processor-chain failures here (enriched via createDLQMessage);
   * withDLQ still owns output-send failure routing when installed.
   * Observation-only for lifecycle — never closed separately; pipeline.output
   * remains the sole close owner.
   */
  readonly dlqOutput?: Output<E, R>;
  readonly backpressure?: BackpressureConfig;
  /** Maximum time allowed for a graceful drain and resource close. */
  readonly shutdownTimeoutMs?: number;
}

/**
 * Statistics from pipeline execution
 */
export interface PipelineStats {
  readonly processed: number;
  readonly failed: number;
  readonly duration: number;
  readonly startTime: number;
  readonly endTime: number;
}

/**
 * Pipeline execution result.
 *
 * `errors` is a bounded diagnostic sample (historical nonfatal failures are
 * capped; distinct fatal causes use fixed first/current slots plus a small
 * extra sample), not a full failure log. Use `stats.failed` for the exact
 * failure count and `errorsOmitted` for how many diagnostics were dropped
 * after a retention cap and are not held in any returned sample.
 *
 * Omission axes (orthogonal):
 * - Identity kind: object/function identities are unique (WeakSet dedupe for
 *   dropped historical objects); primitive values are counted per observation
 *   without retaining the value after the cap (strong state stays O(1)).
 * - Failure class: over-cap historical nonfatals, and fatal overflows past the
 *   fixed first/extra fatal sample that also miss the historical retained
 *   sample. A live current-fatal slot that only holds such an overflow is part
 *   of the returned sample and is not counted as omitted.
 *
 * Terminal close/drain diagnostics are always included when present and are
 * not subject to the historical cap.
 */
export interface PipelineResult {
  readonly success: boolean;
  readonly stats: PipelineStats;
  /** Bounded diagnostic sample; see interface docs for retention semantics. */
  readonly errors?: ReadonlyArray<unknown>;
  /**
   * Diagnostics omitted after a retention cap and not held in any sample.
   * See interface docs for exact counting rules (objects vs primitives, fatals).
   */
  readonly errorsOmitted?: number;
  readonly shutdown?: "graceful" | "timed-out" | "forced";
  readonly metrics?: {
    readonly input?: InputMetrics;
    readonly output?: OutputMetrics;
    readonly dlq?: OutputMetrics;
  };
}

/**
 * Helper to create a message
 */
export const createMessage = <A>(
  content: A,
  metadata: Record<string, unknown> = {},
): Message<A> => ({
  id: crypto.randomUUID(),
  content,
  metadata,
  timestamp: Date.now(),
});
