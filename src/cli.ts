#!/usr/bin/env node
/**
 * CLI entry point for running pipelines
 */
import { Effect, Logger, LogLevel } from "effect";
import { NodeRuntime } from "@effect/platform-node";
import { makeShutdownController, run } from "./core/pipeline.js";
import {
  loadAndBuildPipeline,
  loadRegistry,
  validateConfig,
} from "./cli-config.js";
import { parseCliArgs } from "./cli-args.js";
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

/**
 * Main CLI function
 */
const main = Effect.gen(function* () {
  const args = process.argv.slice(2);

  // Handle help flag
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    showHelp();
    return;
  }

  // Handle version flag
  if (args.includes("--version") || args.includes("-v")) {
    console.log(`cascade v${appVersion}`);
    return;
  }

  const parsed = yield* Effect.try({
    try: () => parseCliArgs(args),
    catch: (error) =>
      error instanceof Error ? error : new Error(String(error)),
  });
  const { command, configPath, debug: debugMode, registryPath } = parsed;
  const registry = registryPath ? yield* loadRegistry(registryPath) : undefined;

  // Handle test command
  if (command === "test") {
    const pattern = configPath;
    if (!pattern) {
      console.error("Error: Missing test pattern argument");
      console.error("Usage: cascade test <pattern>");
      console.error('Example: cascade test "tests/**/*.yaml"');
      yield* Effect.fail(new Error("Missing test pattern"));
      return;
    }

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
    return;
  }

  // Check for pipeline commands
  if (command !== "run" && command !== "validate") {
    console.error(`Error: Unknown command '${command}'`);
    console.error('Run "cascade --help" for usage information.');
    yield* Effect.fail(new Error("Invalid command"));
    return;
  }

  // Get config file path (filter out flags)
  if (!configPath) {
    console.error("Error: Missing config file argument");
    console.error(`Usage: cascade ${command} <config-file.yaml>`);
    yield* Effect.fail(new Error("Missing config file"));
    return;
  }

  yield* Effect.log(`Loading configuration from: ${configPath}`);

  if (command === "validate") {
    const summary = yield* validateConfig(configPath, registry);
    console.log("Configuration is valid");
    console.log(`  Input: ${summary.input}`);
    console.log(
      `  Processors (${summary.processors.length}): ${summary.processors.join(", ") || "none"}`,
    );
    console.log(`  Output: ${summary.output}`);
    console.log(`  DLQ: ${summary.dlq ? "yes" : "no"}`);
    return;
  }

  // Load, validate, and build config with the same registry instance.
  const { config, pipeline } = yield* loadAndBuildPipeline(
    configPath,
    debugMode,
    registry,
  );

  yield* Effect.log(`Configuration loaded successfully`);

  if (debugMode) {
    yield* Effect.logDebug(`Loaded config: ${JSON.stringify(config, null, 2)}`);
  }

  yield* Effect.log(
    `Pipeline built successfully with ${pipeline.processors.length} processors`,
  );

  // Run the pipeline. Signal handlers only complete Effect shutdown signals;
  // draining, timeouts, and resource closure stay in the pipeline runtime.
  yield* Effect.log("Starting pipeline execution...");
  const shutdown = yield* makeShutdownController();
  const result = yield* Effect.acquireUseRelease(
    Effect.sync(() => {
      let signalCount = 0;
      const handleSignal = (signal: NodeJS.Signals) => {
        signalCount += 1;
        if (signalCount === 1) {
          Effect.runFork(
            Effect.log(`Received ${signal}; draining pipeline...`).pipe(
              Effect.zipRight(shutdown.request),
            ),
          );
        } else {
          Effect.runFork(
            Effect.logError(`Received ${signal} again; forcing shutdown`).pipe(
              Effect.zipRight(shutdown.requestForce),
            ),
          );
        }
      };
      process.on("SIGINT", handleSignal);
      process.on("SIGTERM", handleSignal);
      return handleSignal;
    }),
    () => run(pipeline, { shutdown }),
    (handleSignal) =>
      Effect.sync(() => {
        process.off("SIGINT", handleSignal);
        process.off("SIGTERM", handleSignal);
      }),
  );

  if (result.metrics) {
    const rows = [];
    if (result.metrics.input) {
      rows.push({
        component: result.metrics.input.component,
        type: "input",
        processed: result.metrics.input.messagesProcessed,
        dropped: result.metrics.input.messagesDropped,
        sent: "-",
        errors: result.metrics.input.errorsEncountered,
        averageMs: result.metrics.input.averageDuration,
      });
    }
    if (result.metrics.output) {
      rows.push({
        component: result.metrics.output.component,
        type: "output",
        processed: "-",
        dropped: "-",
        sent: result.metrics.output.messagesSent,
        errors: result.metrics.output.sendErrors,
        averageMs: result.metrics.output.averageDuration,
      });
    }
    console.table(rows);
  }

  // Display results
  if (result.success) {
    yield* Effect.log("✓ Pipeline completed successfully!");
    yield* Effect.log(`  Processed: ${result.stats.processed} messages`);
    yield* Effect.log(`  Failed: ${result.stats.failed} messages`);
    yield* Effect.log(`  Duration: ${result.stats.duration}ms`);
  } else {
    yield* Effect.logError("✗ Pipeline failed!");
    if (result.errors) {
      yield* Effect.logError(`  Errors: ${result.errors.length}`);
      for (const error of result.errors) {
        yield* Effect.logError(`    - ${error}`);
      }
    }
    yield* Effect.fail(new Error("Pipeline execution failed"));
  }
}).pipe(
  Effect.catchAll((error) =>
    Effect.gen(function* () {
      // Format error message properly
      let errorMessage = "Unknown error";

      if (error instanceof Error) {
        errorMessage = error.message;
      } else if (typeof error === "string") {
        errorMessage = error;
      } else if (error && typeof error === "object") {
        // Handle Effect errors with _tag
        if ("_tag" in error && typeof error._tag === "string") {
          const tag = error._tag;

          // Handle ConfigValidationError specially
          if (tag === "ConfigValidationError" && "message" in error) {
            const msg = String(error.message);
            // Extract the useful part from the validation error
            if (msg.includes("Schema validation failed:")) {
              const parts = msg.split("Schema validation failed:");
              errorMessage = `Configuration validation failed\n${parts[1]?.trim() || ""}`;
            } else {
              errorMessage = `Configuration validation failed: ${msg}`;
            }
          }
          // Handle FileReadError
          else if (tag === "FileReadError") {
            if ("path" in error) {
              errorMessage = `Cannot read file: ${error.path}`;
            } else {
              errorMessage = "Cannot read configuration file";
            }
          }
          // Handle YamlParseError
          else if (tag === "YamlParseError") {
            if ("message" in error) {
              errorMessage = `Invalid YAML syntax: ${error.message}`;
            } else {
              errorMessage = "Invalid YAML syntax";
            }
          }
          // Generic tagged error
          else {
            errorMessage = tag;
            if ("message" in error) {
              errorMessage += `: ${error.message}`;
            } else if ("error" in error) {
              const err = error as { error: unknown };
              errorMessage += `: ${JSON.stringify(err.error)}`;
            }
          }
        } else {
          errorMessage = JSON.stringify(error, null, 2);
        }
      }

      yield* Effect.logError(`Fatal error: ${errorMessage}`);
      return yield* Effect.fail(error);
    }),
  ),
);

// Run the CLI
const debugMode = process.argv.includes("--debug");
NodeRuntime.runMain(
  main.pipe(
    Logger.withMinimumLogLevel(debugMode ? LogLevel.Debug : LogLevel.Info),
  ) as Effect.Effect<void>,
);
