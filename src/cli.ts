#!/usr/bin/env node
/**
 * CLI entry point for running pipelines
 */
import { Effect, Logger, LogLevel } from "effect";
import { makeShutdownController, run } from "./core/pipeline.js";
import {
  loadAndBuildPipeline,
  loadRegistry,
  validateConfig,
} from "./cli-config.js";
import { parseCliArgs } from "./cli-args.js";
import {
  dispatchCliCommand,
  isHelpRequest,
  isVersionRequest,
  type CliDispatch,
} from "./cli-dispatch.js";
import { formatCliFatalError } from "./cli-errors.js";
import { printPipelineMetrics } from "./cli-metrics.js";
import { runYamlTests, formatTestResults } from "./testing/yaml-test-runner.js";
import packageJson from "../package.json" with { type: "json" };

const appVersion = packageJson.version;

/**
 * Show help message
 */
function showHelp() {
  console.log(`
cascade v${appVersion}

Declarative streaming library inspired by Apache Camel and Benthos

Usage:
  cascade <command> [options]

Commands:
  run <config-file>    Run a pipeline from a YAML configuration file
  validate <config>    Validate and build a pipeline without running it
  test <pattern>       Run YAML tests matching the glob pattern

Options:
  -h, --help          Show this help message
  -v, --version       Show version information
  --debug             Enable debug logging
  --registry <module> Load custom components from a registry module

Examples:
  cascade run configs/example-pipeline.yaml
  cascade run my-pipeline.yaml --debug
  cascade validate my-pipeline.yaml --registry ./registry.js
  cascade test "tests/**/*.yaml"
  cascade test tests/processors/uppercase.test.yaml

Note:
  validate constructs real components. It may briefly bind configured ports or
  open broker connections; use free ports and reachable brokers (or lazy_connect).
`);
}

const runTestCommand = (pattern: string) =>
  Effect.gen(function* () {
    yield* Effect.log(`Running tests matching pattern: ${pattern}`);

    // Run YAML tests
    const result = yield* runYamlTests(pattern);

    // Display formatted results
    console.log(formatTestResults(result));

    // Exit with appropriate code
    if (result.failedTests > 0) {
      yield* Effect.fail(new Error("Some tests failed"));
    } else {
      yield* Effect.log("All tests passed!");
    }
  });

const runValidateCommand = (
  configPath: string,
  registry: Parameters<typeof validateConfig>[1],
) =>
  Effect.gen(function* () {
    const summary = yield* validateConfig(configPath, registry);
    console.log("Configuration is valid");
    console.log(`  Input: ${summary.input}`);
    console.log(
      `  Processors (${summary.processors.length}): ${summary.processors.join(", ") || "none"}`,
    );
    console.log(`  Output: ${summary.output}`);
    console.log(`  DLQ: ${summary.dlq ? "yes" : "no"}`);
  });

const installPipelineSignalHandlers = (shutdown: {
  readonly request: Effect.Effect<void>;
  readonly requestForce: Effect.Effect<void>;
}) => {
  let signalCount = 0;
  const handleSignal = (signal: NodeJS.Signals) => {
    signalCount += 1;
    const effect =
      signalCount === 1
        ? Effect.log(`Received ${signal}; draining pipeline...`).pipe(
            Effect.zipRight(shutdown.request),
          )
        : Effect.logError(`Received ${signal} again; forcing shutdown`).pipe(
            Effect.zipRight(shutdown.requestForce),
          );
    Effect.runFork(effect);
  };
  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);
  return handleSignal;
};

const reportPipelineResult = (result: {
  readonly success: boolean;
  readonly stats: {
    readonly processed: number;
    readonly failed: number;
    readonly duration: number;
  };
  readonly errors?: readonly unknown[];
  readonly errorsOmitted?: number;
  readonly metrics?: Parameters<typeof printPipelineMetrics>[0]["metrics"];
}) =>
  Effect.gen(function* () {
    if (result.success) {
      yield* Effect.log("✓ Pipeline completed successfully!");
      yield* Effect.log(`  Processed: ${result.stats.processed} messages`);
      yield* Effect.log(`  Failed: ${result.stats.failed} messages`);
      yield* Effect.log(`  Duration: ${result.stats.duration}ms`);
      printPipelineMetrics(result);
      return;
    }

    yield* Effect.logError("✗ Pipeline failed!");
    if (result.errors || result.stats.failed > 0 || result.errorsOmitted) {
      const retained = result.errors?.length ?? 0;
      const omitted = result.errorsOmitted ?? 0;
      const totalFailures = result.stats.failed;
      yield* Effect.logError(
        omitted > 0
          ? `  Failures: ${totalFailures} total, showing ${retained} retained sample(s), ${omitted} diagnostic(s) omitted`
          : `  Failures: ${totalFailures} total, showing ${retained} error(s)`,
      );
      if (result.errors) {
        for (const error of result.errors) {
          yield* Effect.logError(`    - ${error}`);
        }
      }
    }
    printPipelineMetrics(result);
    yield* Effect.fail(new Error("Pipeline execution failed"));
  });

const runPipelineCommand = (
  configPath: string,
  debugMode: boolean,
  registry: Parameters<typeof loadAndBuildPipeline>[2],
) =>
  Effect.gen(function* () {
    // Load, validate, and build config with the same registry instance.
    const { config, pipeline } = yield* loadAndBuildPipeline(
      configPath,
      debugMode,
      registry,
    );

    yield* Effect.log(`Configuration loaded successfully`);

    if (debugMode) {
      yield* Effect.logDebug(
        `Loaded config: ${JSON.stringify(config, null, 2)}`,
      );
    }

    yield* Effect.log(
      `Pipeline built successfully with ${pipeline.processors.length} processors`,
    );

    // Run the pipeline. Signal handlers only complete Effect shutdown signals;
    // draining, timeouts, and resource closure stay in the pipeline runtime.
    yield* Effect.log("Starting pipeline execution...");
    const shutdown = yield* makeShutdownController();
    const result = yield* Effect.acquireUseRelease(
      Effect.sync(() => installPipelineSignalHandlers(shutdown)),
      () => run(pipeline, { shutdown }),
      (handleSignal) =>
        Effect.sync(() => {
          process.off("SIGINT", handleSignal);
          process.off("SIGTERM", handleSignal);
        }),
    );

    yield* reportPipelineResult(result);
  });
const runLoadedConfigCommand = (
  decision: Extract<CliDispatch, { kind: "run" | "validate" }>,
  registry: Parameters<typeof validateConfig>[1],
) =>
  Effect.gen(function* () {
    yield* Effect.log(`Loading configuration from: ${decision.configPath}`);
    if (decision.kind === "validate") {
      yield* runValidateCommand(decision.configPath, registry);
      return;
    }
    yield* runPipelineCommand(decision.configPath, decision.debug, registry);
  });

const executeCliDecision = (
  decision: CliDispatch,
  registry: Parameters<typeof validateConfig>[1],
) => {
  if (decision.kind === "usage-error") {
    for (const line of decision.lines) {
      console.error(line);
    }
    return Effect.fail(new Error(decision.errorMessage));
  }
  if (decision.kind === "test") {
    return runTestCommand(decision.pattern);
  }
  return runLoadedConfigCommand(decision, registry);
};

const parseArgsOrError = (args: readonly string[]) =>
  Effect.try({
    try: () => parseCliArgs(args),
    catch: (error) =>
      error instanceof Error ? error : new Error(String(error)),
  });

const loadOptionalRegistry = (registryPath: string | undefined) =>
  registryPath ? loadRegistry(registryPath) : Effect.succeed(undefined);

const runParsedCommand = (parsed: {
  readonly command?: string;
  readonly configPath?: string;
  readonly debug: boolean;
  readonly registryPath?: string;
}) =>
  Effect.gen(function* () {
    // Load optional registry immediately after parsing so every command
    // (including test and usage-error paths) retains the original failure order.
    const registry = yield* loadOptionalRegistry(parsed.registryPath);
    yield* executeCliDecision(
      dispatchCliCommand({
        command: parsed.command ?? "",
        configPath: parsed.configPath,
        debug: parsed.debug,
        registryPath: parsed.registryPath,
      }),
      registry,
    );
  });

/**
 * Main CLI function
 */
const mainProgram = Effect.gen(function* () {
  const args = process.argv.slice(2);
  if (isHelpRequest(args)) {
    showHelp();
    return;
  }
  if (isVersionRequest(args)) {
    console.log(`cascade v${appVersion}`);
    return;
  }

  const parsed = yield* parseArgsOrError(args);
  yield* runParsedCommand(parsed);
});

const main = mainProgram.pipe(
  Effect.catchAll((error) =>
    Effect.gen(function* () {
      yield* Effect.logError(`Fatal error: ${formatCliFatalError(error)}`);
      return yield* Effect.fail(error);
    }),
  ),
);

// Run the CLI.
// Avoid NodeRuntime.runMain: it installs SIGINT/SIGTERM handlers that interrupt
// the root fiber immediately, which races the CLI's graceful drain path and
// exits before processed/failed summaries are written (HTTP input E2E).
const debugMode = process.argv.includes("--debug");
const program = main.pipe(
  Logger.withMinimumLogLevel(debugMode ? LogLevel.Debug : LogLevel.Info),
  Effect.provide(
    Logger.replace(Logger.defaultLogger, Logger.prettyLoggerDefault),
  ),
);

// Force process exit after the pipeline finishes. Component transports
// (Redis, HTTP servers, SQS clients) can leave handles open that would
// otherwise keep Node alive after a graceful drain summary is written.
Effect.runPromise(program as Effect.Effect<void>).then(
  () => {
    process.exit(0);
  },
  () => {
    process.exit(1);
  },
);
