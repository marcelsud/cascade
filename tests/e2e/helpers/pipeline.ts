import { Effect } from "effect";
import {
  makeShutdownController,
  run,
  type PipelineShutdownController,
  type RunOptions,
} from "../../../src/core/pipeline.js";
import type { Pipeline, PipelineResult } from "../../../src/core/types.js";

export interface RunningPipeline {
  readonly shutdown: PipelineShutdownController;
  readonly result: Promise<PipelineResult>;
}

export const startPipeline = async <E>(
  pipeline: Pipeline<E, never>,
  options: RunOptions = {},
): Promise<RunningPipeline> => {
  const shutdown =
    options.shutdown ?? (await Effect.runPromise(makeShutdownController()));
  return {
    shutdown,
    result: Effect.runPromise(run(pipeline, { ...options, shutdown })),
  };
};

export const runPipeline = async <E>(
  pipeline: Pipeline<E, never>,
  options?: RunOptions,
): Promise<PipelineResult> => (await startPipeline(pipeline, options)).result;
