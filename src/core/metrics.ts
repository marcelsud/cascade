/**
 * Core metrics collection utilities
 * Metrics are emitted via structured logging for observability
 */
import { Effect } from "effect";

/**
 * Base metrics interface for all components
 */
export interface ComponentMetrics {
  readonly component: string;
  readonly timestamp: number;
}

/**
 * Input component metrics
 */
export interface InputMetrics extends ComponentMetrics {
  readonly messagesProcessed: number;
  readonly messagesDropped: number;
  readonly errorsEncountered: number;
  readonly averageDuration: number; // milliseconds
  readonly totalDuration: number; // milliseconds
}

/**
 * Output component metrics
 */
export interface OutputMetrics extends ComponentMetrics {
  readonly messagesSent: number;
  readonly batchesSent: number;
  readonly sendErrors: number;
  readonly averageDuration: number; // milliseconds
  readonly totalDuration: number; // milliseconds
}

/**
 * Metrics accumulator for tracking component operations
 */
export class MetricsAccumulator {
  private messagesProcessed = 0;
  private messagesDropped = 0;
  private messagesSent = 0;
  private batchesSent = 0;
  private errorsEncountered = 0;
  private sendErrors = 0;
  private totalDuration = 0;
  private operationCount = 0;

  constructor(private readonly componentName: string) {}

  /**
   * Record successful message processing
   */
  recordProcessed(durationMs: number = 0): void {
    this.messagesProcessed++;
    this.totalDuration += durationMs;
    this.operationCount++;
  }

  /** Record a message discarded by an explicitly configured overflow policy. */
  recordDropped(): void {
    this.messagesDropped++;
  }

  /**
   * Record message send
   */
  recordSent(count: number = 1, durationMs: number = 0): void {
    this.messagesSent += count;
    this.totalDuration += durationMs;
    this.operationCount++;
  }

  /**
   * Record batch send
   */
  recordBatch(messageCount: number, durationMs: number = 0): void {
    this.messagesSent += messageCount;
    this.batchesSent++;
    this.totalDuration += durationMs;
    this.operationCount++;
  }

  /**
   * Record error
   */
  recordError(): void {
    this.errorsEncountered++;
  }

  /**
   * Record send error
   */
  recordSendError(): void {
    this.sendErrors++;
  }

  /**
   * Get input metrics snapshot
   */
  getInputMetrics(): InputMetrics {
    return {
      component: this.componentName,
      timestamp: Date.now(),
      messagesProcessed: this.messagesProcessed,
      messagesDropped: this.messagesDropped,
      errorsEncountered: this.errorsEncountered,
      averageDuration:
        this.operationCount > 0
          ? Math.round(this.totalDuration / this.operationCount)
          : 0,
      totalDuration: Math.round(this.totalDuration),
    };
  }

  /**
   * Get output metrics snapshot
   */
  getOutputMetrics(): OutputMetrics {
    return {
      component: this.componentName,
      timestamp: Date.now(),
      messagesSent: this.messagesSent,
      batchesSent: this.batchesSent,
      sendErrors: this.sendErrors,
      averageDuration:
        this.operationCount > 0
          ? Math.round(this.totalDuration / this.operationCount)
          : 0,
      totalDuration: Math.round(this.totalDuration),
    };
  }

  /**
   * Reset all counters
   */
  reset(): void {
    this.messagesProcessed = 0;
    this.messagesDropped = 0;
    this.messagesSent = 0;
    this.batchesSent = 0;
    this.errorsEncountered = 0;
    this.sendErrors = 0;
    this.totalDuration = 0;
    this.operationCount = 0;
  }
}

/**
 * Emit input metrics via structured logging
 */
export const emitInputMetrics = (
  metrics: InputMetrics,
): Effect.Effect<void, never, never> =>
  Effect.logInfo("Component metrics", {
    component: metrics.component,
    type: "input",
    messagesProcessed: metrics.messagesProcessed,
    messagesDropped: metrics.messagesDropped,
    errorsEncountered: metrics.errorsEncountered,
    averageDuration: metrics.averageDuration,
    totalDuration: metrics.totalDuration,
    timestamp: metrics.timestamp,
  });

/**
 * Emit output metrics via structured logging
 */
export const emitOutputMetrics = (
  metrics: OutputMetrics,
): Effect.Effect<void, never, never> =>
  Effect.logInfo("Component metrics", {
    component: metrics.component,
    type: "output",
    messagesSent: metrics.messagesSent,
    batchesSent: metrics.batchesSent,
    sendErrors: metrics.sendErrors,
    averageDuration: metrics.averageDuration,
    totalDuration: metrics.totalDuration,
    timestamp: metrics.timestamp,
  });

/**
 * Create a performance timer Effect
 */
export const measureDuration = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<[A, number], E, R> =>
  Effect.gen(function* () {
    const start = Date.now();
    const result = yield* effect;
    const duration = Date.now() - start;
    return [result, duration] as [A, number];
  });
