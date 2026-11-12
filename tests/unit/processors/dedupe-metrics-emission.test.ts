import { describe, it, expect } from "vitest";
import { Effect, Logger, References } from "effect";
import * as S from "effect/Schema";
import { PipelineConfigSchema } from "../../../src/core/config-loader.js";
import { buildPipeline } from "../../../src/core/pipeline-builder.js";
import { run } from "../../../src/core/pipeline.js";

/**
 * Captured Effect log record. Effect.logInfo("Component metrics", fields)
 * puts the label and structured payload in `message` (as an array); fiber
 * annotations (if any) land in `annotations`.
 */
interface CapturedLog {
  readonly message: unknown;
  readonly annotations: Readonly<Record<string, unknown>>;
}

const extractComponentMetricsFields = (
  message: unknown,
): Record<string, unknown> | undefined => {
  const parts = Array.isArray(message) ? message : [message];
  const label = parts.find((part) => typeof part === "string");
  if (label !== "Component metrics") {
    return undefined;
  }
  const fields = parts.find(
    (part) =>
      part !== null &&
      typeof part === "object" &&
      !Array.isArray(part) &&
      "component" in (part as Record<string, unknown>),
  ) as Record<string, unknown> | undefined;
  return fields;
};

const dedupeComponentMetrics = (
  logs: readonly CapturedLog[],
): Array<Record<string, unknown>> => {
  const snapshots: Array<Record<string, unknown>> = [];
  for (const log of logs) {
    const fields = extractComponentMetricsFields(log.message);
    if (fields === undefined) {
      continue;
    }
    // Prefer the structured payload's component; fall back to fiber annotations.
    const annotationComponent = log.annotations.component;
    const component = fields.component ?? annotationComponent;
    if (component === "dedupe-processor") {
      snapshots.push(fields);
    }
  }
  return snapshots;
};

describe("Dedupe processor component metrics emission", () => {
  it("emits one coherent Component metrics snapshot via buildPipeline + run after 100 same-key messages", async () => {
    const logs: CapturedLog[] = [];
    const logger = Logger.make<unknown, void>(({ message, fiber }) => {
      logs.push({
        message,
        annotations: fiber.getRef(References.CurrentLogAnnotations),
      });
    });

    const config = await Effect.runPromise(
      S.decodeUnknownEffect(PipelineConfigSchema)({
        input: {
          generate: {
            count: 100,
            template: { id: "same" },
          },
        },
        pipeline: {
          processors: [{ dedupe: { key: "id" } }],
        },
        output: { capture: {} },
      }),
    );

    // AC-1: metrics must be reached through the ordinary config/YAML path.
    // Neither this test nor application code may call getMetrics / emitDedupeMetrics.
    const pipeline = await Effect.runPromise(buildPipeline(config));
    const result = await Effect.runPromise(
      run(pipeline).pipe(Effect.provide(Logger.layer([logger]))),
    );

    expect(result.success).toBe(true);
    // One first-seen pass-through; 99 suppressed duplicates never reach output.
    expect(result.stats.processed).toBe(1);

    const snapshots = dedupeComponentMetrics(logs);

    // AC-1 / AC-3 / AC-6: exactly one bounded snapshot, not one per message.
    expect(snapshots).toHaveLength(1);

    const snapshot = snapshots[0];

    // AC-2 / AC-4: processor-typed coherent post-update counters.
    expect(snapshot.type).toBe("processor");
    expect(snapshot.component).toBe("dedupe-processor");
    expect(snapshot.dedupeMisses).toBe(1);
    expect(snapshot.dedupeHits).toBe(99);
    expect(snapshot.extractionFailures).toBe(0);
    expect(snapshot.activeKeys).toBe(1);
    expect(typeof snapshot.timestamp).toBe("number");

    // Guard against accidentally matching an input/output Component metrics record.
    expect(snapshot).not.toHaveProperty("messagesProcessed");
    expect(snapshot).not.toHaveProperty("messagesSent");
  });
});
