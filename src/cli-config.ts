import { Effect } from "effect";
import { pathToFileURL } from "node:url";
import * as path from "node:path";
import { ComponentRegistry } from "./core/component-registry.js";
import { loadConfig } from "./core/config-loader.js";
import { buildPipeline } from "./core/pipeline-builder.js";
import type { Pipeline } from "./core/types.js";

export class RegistryLoadError extends Error {
  readonly _tag = "RegistryLoadError";

  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "RegistryLoadError";
  }
}

export interface ConfigSummary {
  readonly input: string;
  readonly processors: ReadonlyArray<string>;
  readonly output: string;
  readonly dlq: boolean;
}

const selectedComponent = (config: object): string =>
  Object.entries(config).find(([, value]) => value !== undefined)?.[0] ??
  "unknown";

export const loadRegistry = (
  modulePath: string,
): Effect.Effect<ComponentRegistry, RegistryLoadError> =>
  Effect.tryPromise({
    try: async () => {
      const absolutePath = path.resolve(modulePath);
      const module = (await import(pathToFileURL(absolutePath).href)) as {
        readonly default?: unknown;
      };
      if (!(module.default instanceof ComponentRegistry)) {
        throw new RegistryLoadError(
          `Registry module '${modulePath}' must default-export a ComponentRegistry`,
        );
      }
      return module.default;
    },
    catch: (error) =>
      error instanceof RegistryLoadError
        ? error
        : new RegistryLoadError(
            `Failed to load registry module '${modulePath}': ${String(error)}`,
            error,
          ),
  });

export const loadAndBuildPipeline = (
  configPath: string,
  debug = false,
  registry?: ComponentRegistry,
) =>
  Effect.gen(function* () {
    const config = yield* loadConfig(configPath, registry);
    const pipeline = yield* buildPipeline(config, debug, registry);
    return { config, pipeline };
  });

const closeBuiltPipeline = (pipeline: Pipeline<any>) =>
  Effect.gen(function* () {
    if (pipeline.input.close) yield* pipeline.input.close();
    if (pipeline.output.close) yield* pipeline.output.close();
  });

export const validateConfig = (
  configPath: string,
  registry?: ComponentRegistry,
): Effect.Effect<ConfigSummary, unknown> =>
  Effect.acquireUseRelease(
    loadAndBuildPipeline(configPath, false, registry),
    ({ config }) =>
      Effect.succeed({
        input: selectedComponent(config.input),
        processors: (config.pipeline?.processors ?? []).map(selectedComponent),
        output: selectedComponent(config.output),
        dlq: config.dlq !== undefined,
      }),
    ({ pipeline }) => closeBuiltPipeline(pipeline).pipe(Effect.orDie),
  );
