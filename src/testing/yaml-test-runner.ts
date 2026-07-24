/**
 * YAML Test Runner
 *
 * Runs tests defined in YAML files using the testing utilities
 */
import { Cause, Effect, Exit, Option } from "effect";
import { glob } from "glob";
import { parseTestFile, type Test, type TestFile } from "./test-file-parser.js";
import { buildPipeline } from "../core/pipeline-builder.js";
import { run as runPipeline } from "../core/pipeline.js";
import type { PipelineConfig as CorePipelineConfig } from "../core/config-schema.js";
import type { Message } from "../core/types.js";
import { executeAssertions, type AssertionContext } from "./assertions.js";

/**
 * Test result for a single test case
 */
interface TestResult {
  readonly testName: string;
  readonly passed: boolean;
  readonly duration: number;
  readonly error?: string;
  readonly assertionResults?: readonly {
    readonly passed: boolean;
    readonly message: string;
  }[];
}

/**
 * Test file result
 */
export interface TestFileResult {
  readonly fileName: string;
  readonly tests: readonly TestResult[];
  readonly passed: boolean;
  readonly duration: number;
}

/**
 * Overall test run result
 */
export interface TestRunResult {
  readonly files: readonly TestFileResult[];
  readonly totalTests: number;
  readonly passedTests: number;
  readonly failedTests: number;
  readonly duration: number;
}

const formatUnknownError = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error === "object") {
    const message =
      "message" in error && typeof error.message === "string"
        ? error.message
        : undefined;
    const tag =
      "_tag" in error && typeof error._tag === "string"
        ? error._tag
        : undefined;

    if (message !== undefined) {
      return tag !== undefined ? `${tag}: ${message}` : message;
    }
    if (tag !== undefined) {
      return tag;
    }
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

const getErrorType = (error: unknown): string | undefined => {
  if (error && typeof error === "object" && "_tag" in error) {
    if (typeof error._tag === "string") {
      return error._tag;
    }
  }
  if (error instanceof Error && error.name) {
    return error.name;
  }
  return undefined;
};

const errorFromCause = (cause: Cause.Cause<unknown>): unknown => {
  const failure = Cause.failureOption(cause);
  if (Option.isSome(failure)) {
    return failure.value;
  }

  const defect = Cause.dieOption(cause);
  if (Option.isSome(defect)) {
    return defect.value;
  }

  return new Error(Cause.pretty(cause));
};

const matchExpectError = (
  test: Test,
  error: unknown,
  startTime: number,
): TestResult => {
  const expectError = test.expectError;
  if (!expectError) {
    return {
      testName: test.name,
      passed: false,
      duration: Date.now() - startTime,
      error: `Unexpected error: ${formatUnknownError(error)}`,
    };
  }

  // Vacuous expectError ({} / blank-only fields) must never match arbitrary failures.
  const hasType =
    typeof expectError.type === "string" && expectError.type.trim().length > 0;
  const hasMessage =
    typeof expectError.messageContains === "string" &&
    expectError.messageContains.trim().length > 0;
  if (!hasType && !hasMessage) {
    return {
      testName: test.name,
      passed: false,
      duration: Date.now() - startTime,
      error:
        "expectError requires a non-empty type and/or messageContains discriminator",
    };
  }

  if (hasType) {
    const errorType = getErrorType(error);
    if (errorType !== expectError.type) {
      return {
        testName: test.name,
        passed: false,
        duration: Date.now() - startTime,
        error: `Expected error type '${expectError.type}' but got '${errorType ?? "undefined"}'`,
      };
    }
  }

  if (hasMessage) {
    const expectedFragment = expectError.messageContains ?? "";
    const errorMessage = formatUnknownError(error);
    if (!errorMessage.includes(expectedFragment)) {
      return {
        testName: test.name,
        passed: false,
        duration: Date.now() - startTime,
        error: `Expected error message to contain '${expectedFragment}' but got: ${errorMessage}`,
      };
    }
  }

  return {
    testName: test.name,
    passed: true,
    duration: Date.now() - startTime,
  };
};

const getCapturedMessages = (
  output: unknown,
): Effect.Effect<readonly Message[]> => {
  if (
    output &&
    typeof output === "object" &&
    "getMessages" in output &&
    typeof output.getMessages === "function"
  ) {
    const getMessages = output.getMessages as () => Effect.Effect<
      readonly Message[]
    >;
    // Capture-output testing sink is the only path that exposes getMessages.
    return getMessages();
  }

  return Effect.succeed([]);
};

/**
 * Map test-file DSL pipeline settings onto core PipelineConfig shapes.
 * Keeps processors as-is; nests dlq at root; maps camelCase DSL fields.
 */
const toBuildPipelineConfig = (test: Test): CorePipelineConfig => {
  const processors = test.pipeline.processors ?? [];
  const concurrency = test.pipeline.backpressure?.concurrency;
  const backpressure =
    concurrency !== undefined
      ? {
          // Honor the single DSL concurrency knob for both runtime limits.
          max_concurrent_messages: concurrency,
          max_concurrent_outputs: concurrency,
        }
      : undefined;

  const dlq = test.pipeline.dlq
    ? {
        output: test.pipeline.dlq.output,
        ...(test.pipeline.dlq.maxRetries !== undefined
          ? { max_retries: test.pipeline.dlq.maxRetries }
          : {}),
        ...(test.pipeline.dlq.retryDelay !== undefined
          ? { retry_interval_ms: test.pipeline.dlq.retryDelay }
          : {}),
      }
    : undefined;

  // Test YAML payloads are component records validated at build time.
  return {
    input: test.pipeline.input,
    pipeline: {
      processors,
      ...(backpressure ? { backpressure } : {}),
    },
    output: test.pipeline.output,
    ...(dlq ? { dlq } : {}),
  } as unknown as CorePipelineConfig;
};

/**
 * Run a single test case
 */
const runTest = (test: Test, _fileName: string) =>
  Effect.gen(function* () {
    const startTime = Date.now();

    const buildAndRun = Effect.gen(function* () {
      const pipeline = yield* buildPipeline(toBuildPipelineConfig(test));

      const result = yield* runPipeline(pipeline);
      // Wrapped output owns close; observe unwrapped primary/DLQ captures.
      const outputMessages = yield* getCapturedMessages(
        pipeline.primaryOutput ?? pipeline.output,
      );
      const dlqMessages = yield* getCapturedMessages(pipeline.dlqOutput);

      return { result, outputMessages, dlqMessages } as const;
    });

    const exit = yield* Effect.exit(buildAndRun);

    if (Exit.isFailure(exit)) {
      const error = errorFromCause(exit.cause);
      if (test.expectError) {
        return matchExpectError(test, error, startTime);
      }

      return {
        testName: test.name,
        passed: false,
        duration: Date.now() - startTime,
        error: `Unexpected error: ${formatUnknownError(error)}`,
      } satisfies TestResult;
    }

    const { result, outputMessages, dlqMessages } = exit.value;
    const pipelineError = result.errors?.[0];

    if (test.expectError) {
      if (result.success) {
        return {
          testName: test.name,
          passed: false,
          duration: Date.now() - startTime,
          error: "Expected pipeline to fail but it succeeded",
        } satisfies TestResult;
      }

      return matchExpectError(
        test,
        pipelineError ?? new Error("Pipeline failed without error details"),
        startTime,
      );
    }

    // Run assertions even when the pipeline failed so pipeline_failed can pass.
    if (test.assertions && test.assertions.length > 0) {
      const context: AssertionContext = {
        outputMessages,
        dlqMessages,
        pipelineSuccess: result.success,
        pipelineError,
      };

      const assertionsExit = yield* Effect.exit(
        executeAssertions(test.assertions, context),
      );

      if (Exit.isFailure(assertionsExit)) {
        return {
          testName: test.name,
          passed: false,
          duration: Date.now() - startTime,
          error: `Assertion error: ${formatUnknownError(errorFromCause(assertionsExit.cause))}`,
        } satisfies TestResult;
      }

      const assertionResults = assertionsExit.value;
      const allAssertionsPassed = assertionResults.every((r) => r.passed);
      const allowsFailedPipeline =
        !result.success &&
        test.assertions.some(
          (assertion) => assertion.type === "pipeline_failed",
        );

      // Ordinary assertions must not mask an unexpected pipeline failure.
      if (!result.success && !allowsFailedPipeline) {
        return {
          testName: test.name,
          passed: false,
          duration: Date.now() - startTime,
          error: `Pipeline failed: ${formatUnknownError(pipelineError ?? "unknown error")}`,
          assertionResults: assertionResults.map((r) => ({
            passed: r.passed,
            message: r.message,
          })),
        } satisfies TestResult;
      }

      return {
        testName: test.name,
        passed: allAssertionsPassed,
        duration: Date.now() - startTime,
        assertionResults: assertionResults.map((r) => ({
          passed: r.passed,
          message: r.message,
        })),
      } satisfies TestResult;
    }

    if (!result.success) {
      return {
        testName: test.name,
        passed: false,
        duration: Date.now() - startTime,
        error: `Pipeline failed: ${formatUnknownError(pipelineError ?? "unknown error")}`,
      } satisfies TestResult;
    }

    return {
      testName: test.name,
      passed: true,
      duration: Date.now() - startTime,
    } satisfies TestResult;
  });

/**
 * Run all tests in a test file
 */
const runTestFile = (testFile: TestFile, fileName: string) =>
  Effect.gen(function* () {
    const startTime = Date.now();

    const testResults: TestResult[] = [];
    for (const test of testFile.tests) {
      const testStartTime = Date.now();
      const testExit = yield* Effect.exit(runTest(test, fileName));
      if (Exit.isFailure(testExit)) {
        testResults.push({
          testName: test.name,
          passed: false,
          duration: Date.now() - testStartTime,
          error: `Unexpected error: ${formatUnknownError(errorFromCause(testExit.cause))}`,
        });
        continue;
      }
      testResults.push(testExit.value);
    }

    return {
      fileName,
      tests: testResults,
      passed: testResults.every((r) => r.passed),
      duration: Date.now() - startTime,
    } satisfies TestFileResult;
  });

const failedFileResult = (
  filePath: string,
  error: unknown,
  startTime: number,
): TestFileResult => ({
  fileName: filePath,
  tests: [
    {
      testName: "<file>",
      passed: false,
      duration: Date.now() - startTime,
      error: formatUnknownError(error),
    },
  ],
  passed: false,
  duration: Date.now() - startTime,
});

/**
 * Find test files matching pattern
 */
export const findTestFiles = (
  pattern: string,
): Effect.Effect<readonly string[], Error> =>
  Effect.tryPromise({
    try: async () => {
      const files = await glob(pattern, {
        absolute: true,
        nodir: true,
      });
      return files
        .filter((filePath) => {
          const lower = filePath.toLowerCase();
          return lower.endsWith(".test.yaml") || lower.endsWith(".test.yml");
        })
        .sort((a, b) => a.localeCompare(b));
    },
    catch: (error) => new Error(`Failed to find test files: ${error}`),
  });

/**
 * Run YAML tests
 */
export const runYamlTests = (pattern: string) =>
  Effect.gen(function* () {
    const startTime = Date.now();

    // Find test files
    const filePaths = yield* findTestFiles(pattern);

    if (filePaths.length === 0) {
      const error = `No test files found matching pattern: ${pattern}`;
      yield* Effect.log(error);
      return {
        files: [
          {
            fileName: pattern,
            passed: false,
            duration: 0,
            tests: [
              {
                testName: "<no matching files>",
                passed: false,
                duration: 0,
                error,
              },
            ],
          },
        ],
        totalTests: 1,
        passedTests: 0,
        failedTests: 1,
        duration: Date.now() - startTime,
      } satisfies TestRunResult;
    }

    yield* Effect.log(`Found ${filePaths.length} test file(s)`);

    // Isolate each file: parse/run failures become file results, never abort the suite.
    const fileResults: TestFileResult[] = [];
    for (const filePath of filePaths) {
      const fileStartTime = Date.now();
      const parseExit = yield* Effect.exit(parseTestFile(filePath));

      if (Exit.isFailure(parseExit)) {
        fileResults.push(
          failedFileResult(
            filePath,
            errorFromCause(parseExit.cause),
            fileStartTime,
          ),
        );
        continue;
      }

      const fileResultExit = yield* Effect.exit(
        runTestFile(parseExit.value, filePath),
      );

      if (Exit.isFailure(fileResultExit)) {
        fileResults.push(
          failedFileResult(
            filePath,
            errorFromCause(fileResultExit.cause),
            fileStartTime,
          ),
        );
        continue;
      }

      fileResults.push(fileResultExit.value);
    }

    const totalTests = fileResults.reduce(
      (sum, file) => sum + file.tests.length,
      0,
    );
    const passedTests = fileResults.reduce(
      (sum, file) => sum + file.tests.filter((t) => t.passed).length,
      0,
    );

    return {
      files: fileResults,
      totalTests,
      passedTests,
      failedTests: totalTests - passedTests,
      duration: Date.now() - startTime,
    } satisfies TestRunResult;
  });

/**
 * Format test results for display
 */
export const formatTestResults = (result: TestRunResult): string => {
  const lines: string[] = [];

  lines.push("");
  lines.push("=".repeat(70));
  lines.push("YAML Test Results");
  lines.push("=".repeat(70));
  lines.push("");

  for (const file of result.files) {
    const fileStatus = file.passed ? "✓" : "✗";
    lines.push(`${fileStatus} ${file.fileName} (${file.duration}ms)`);

    for (const test of file.tests) {
      const testStatus = test.passed ? "  ✓" : "  ✗";
      lines.push(`${testStatus} ${test.testName} (${test.duration}ms)`);

      if (test.error) {
        lines.push(`     Error: ${test.error}`);
      }

      if (test.assertionResults) {
        for (const assertion of test.assertionResults) {
          lines.push(`     ${assertion.message}`);
        }
      }
    }

    lines.push("");
  }

  lines.push("=".repeat(70));
  lines.push(
    `Tests: ${result.passedTests} passed, ${result.failedTests} failed, ${result.totalTests} total`,
  );
  lines.push(`Time:  ${result.duration}ms`);
  lines.push("=".repeat(70));
  lines.push("");

  return lines.join("\n");
};
