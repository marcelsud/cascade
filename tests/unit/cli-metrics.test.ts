import { describe, expect, it, vi } from "vitest";
import {
  buildPipelineMetricRows,
  printPipelineMetrics,
} from "../../src/cli-metrics.js";

describe("cli-metrics", () => {
  it("builds empty rows when metrics are absent", () => {
    expect(buildPipelineMetricRows(undefined)).toEqual([]);
  });

  it("maps input, output, and dlq metrics into table rows", () => {
    expect(
      buildPipelineMetricRows({
        input: {
          component: "generate",
          messagesProcessed: 10,
          messagesDropped: 1,
          errorsEncountered: 2,
          averageDuration: 3,
        },
        output: {
          component: "stdout",
          messagesSent: 9,
          sendErrors: 0,
          averageDuration: 4,
        },
        dlq: {
          component: "dlq-out",
          messagesSent: 1,
          sendErrors: 1,
          averageDuration: 5,
        },
      }),
    ).toEqual([
      {
        component: "generate",
        type: "input",
        processed: 10,
        dropped: 1,
        sent: "-",
        errors: 2,
        averageMs: 3,
      },
      {
        component: "stdout",
        type: "output",
        processed: "-",
        dropped: "-",
        sent: 9,
        errors: 0,
        averageMs: 4,
      },
      {
        component: "dlq-out",
        type: "dlq",
        processed: "-",
        dropped: "-",
        sent: 1,
        errors: 1,
        averageMs: 5,
      },
    ]);
  });

  it("prints only present metric sections via console.table", () => {
    const table = vi
      .spyOn(console, "table")
      .mockImplementation(() => undefined);

    printPipelineMetrics({});
    expect(table).not.toHaveBeenCalled();

    printPipelineMetrics({
      metrics: {
        output: {
          component: "capture",
          messagesSent: 2,
          sendErrors: 0,
          averageDuration: 1,
        },
      },
    });
    expect(table).toHaveBeenCalledWith([
      {
        component: "capture",
        type: "output",
        processed: "-",
        dropped: "-",
        sent: 2,
        errors: 0,
        averageMs: 1,
      },
    ]);

    table.mockRestore();
  });
});
