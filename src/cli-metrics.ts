/**
 * Pure helpers for formatting pipeline run metrics into console.table rows.
 */

export type PipelineMetricsSnapshot = {
  readonly input?: {
    readonly component: string;
    readonly messagesProcessed: number;
    readonly messagesDropped: number;
    readonly errorsEncountered: number;
    readonly averageDuration: number;
  };
  readonly output?: {
    readonly component: string;
    readonly messagesSent: number;
    readonly sendErrors: number;
    readonly averageDuration: number;
  };
  readonly dlq?: {
    readonly component: string;
    readonly messagesSent: number;
    readonly sendErrors: number;
    readonly averageDuration: number;
  };
};

export type PipelineMetricRow = {
  readonly component: string;
  readonly type: "input" | "output" | "dlq";
  readonly processed: number | "-";
  readonly dropped: number | "-";
  readonly sent: number | "-";
  readonly errors: number;
  readonly averageMs: number;
};

/**
 * Convert a pipeline metrics snapshot into console.table rows.
 * Returns an empty array when metrics are absent.
 */
export const buildPipelineMetricRows = (
  metrics: PipelineMetricsSnapshot | undefined,
): PipelineMetricRow[] => {
  if (!metrics) return [];

  const rows: PipelineMetricRow[] = [];
  if (metrics.input) {
    rows.push({
      component: metrics.input.component,
      type: "input",
      processed: metrics.input.messagesProcessed,
      dropped: metrics.input.messagesDropped,
      sent: "-",
      errors: metrics.input.errorsEncountered,
      averageMs: metrics.input.averageDuration,
    });
  }
  if (metrics.output) {
    rows.push({
      component: metrics.output.component,
      type: "output",
      processed: "-",
      dropped: "-",
      sent: metrics.output.messagesSent,
      errors: metrics.output.sendErrors,
      averageMs: metrics.output.averageDuration,
    });
  }
  if (metrics.dlq) {
    rows.push({
      component: metrics.dlq.component,
      type: "dlq",
      processed: "-",
      dropped: "-",
      sent: metrics.dlq.messagesSent,
      errors: metrics.dlq.sendErrors,
      averageMs: metrics.dlq.averageDuration,
    });
  }
  return rows;
};

export const printPipelineMetrics = (result: {
  readonly metrics?: PipelineMetricsSnapshot;
}): void => {
  const metrics = result.metrics;
  if (!metrics) return;
  console.table(buildPipelineMetricRows(metrics));
};
