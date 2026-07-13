#!/usr/bin/env node
/**
 * CLI entry point for running pipelines
 */
import { Effect, Logger, LogLevel } from "effect";
import { NodeRuntime } from "@effect/platform-node";
import { loadConfig } from "./core/config-loader.js";
import { buildPipeline } from "./core/pipeline-builder.js";
import { makeShutdownController, run } from "./core/pipeline.js";
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
  test <pattern>       Run YAML tests matching the glob pattern

Options:
  -h, --help          Show this help message
  -v, --version       Show version information
  --debug             Enable debug logging

Examples:
  cascade run configs/example-pipeline.yaml
  cascade run my-pipeline.yaml --debug
  cascade test "tests/**/*.yaml"
  cascade test tests/processors/uppercase.test.yaml
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

  // Check for debug flag
  const debugMode = args.includes("--debug");

  // Handle test command
  if (args[0] === "test") {
    const pattern = args.find((arg) => !arg.startsWith("--") && arg !== "test");
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

  // Check for run command
  if (args[0] !== "run") {
    console.error(`Error: Unknown command '${args[0]}'`);
    console.error('Run "cascade --help" for usage information.');
    yield* Effect.fail(new Error("Invalid command"));
    return;
  }

  // Get config file path (filter out flags)
  const configPath = args.find((arg) => !arg.startsWith("--") && arg !== "run");
  if (!configPath) {
    console.error("Error: Missing config file argument");
    console.error("Usage: cascade run <config-file.yaml>");
    yield* Effect.fail(new Error("Missing config file"));
    return;
  }

  yield* Effect.log(`Loading configuration from: ${configPath}`);

  // Load and validate config
  const config = yield* loadConfig(configPath);

  yield* Effect.log(`Configuration loaded successfully`);

  if (debugMode) {
    yield* Effect.logDebug(`Loaded config: ${JSON.stringify(config, null, 2)}`);
  }

  // Build pipeline from config
  const pipeline = yield* buildPipeline(config, debugMode);

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
