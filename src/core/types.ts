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
 * Pipeline execution result
 */
export interface PipelineResult {
  readonly success: boolean;
  readonly stats: PipelineStats;
  readonly errors?: ReadonlyArray<unknown>;
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
