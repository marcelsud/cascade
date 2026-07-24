/**
 * Test File Parser for YAML Test Runner
 *
 * Parses and validates YAML test files
 */
import { Effect } from "effect";
import * as Schema from "effect/Schema";
import * as yaml from "yaml";
import * as fs from "node:fs/promises";
import type { Assertion } from "./assertions.js";

/**
 * Test file structure
 */
export interface TestFile {
  readonly name: string;
  readonly tests: readonly Test[];
}

/**
 * Individual test case
 */
export interface Test {
  readonly name: string;
  readonly pipeline: PipelineConfig;
  readonly assertions?: readonly Assertion[];
  readonly expectError?: ExpectError;
}

/**
 * Pipeline configuration in test
 */
export interface PipelineConfig {
  readonly input: Record<string, unknown>;
  readonly processors?: readonly Record<string, unknown>[];
  readonly output: Record<string, unknown>;
  readonly dlq?: DLQConfig;
  readonly backpressure?: BackpressureConfig;
}

/**
 * DLQ configuration in test
 */
export interface DLQConfig {
  readonly output: Record<string, unknown>;
  readonly maxRetries?: number;
  readonly retryDelay?: number;
}

/**
 * Backpressure configuration
 */
export interface BackpressureConfig {
  readonly concurrency?: number;
}

/**
 * Expected error configuration
 */
export interface ExpectError {
  readonly type?: string;
  readonly messageContains?: string;
}

/**
 * Schema for assertion types
 */
const AssertionSchema: Schema.Schema<Assertion> = Schema.Union(
  // Message count assertions
  Schema.Struct({
    type: Schema.Literal("message_count"),
    expected: Schema.Number,
    target: Schema.optional(
      Schema.Union(Schema.Literal("output"), Schema.Literal("dlq")),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("message_count_less_than"),
    expected: Schema.Number,
    target: Schema.optional(
      Schema.Union(Schema.Literal("output"), Schema.Literal("dlq")),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("message_count_greater_than"),
    expected: Schema.Number,
    target: Schema.optional(
      Schema.Union(Schema.Literal("output"), Schema.Literal("dlq")),
    ),
  }),

  // Field assertions
  Schema.Struct({
    type: Schema.Literal("field_value"),
    message: Schema.Number,
    path: Schema.String,
    expected: Schema.Unknown,
    target: Schema.optional(
      Schema.Union(Schema.Literal("output"), Schema.Literal("dlq")),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("field_exists"),
    message: Schema.Number,
    path: Schema.String,
    target: Schema.optional(
      Schema.Union(Schema.Literal("output"), Schema.Literal("dlq")),
    ),
  }),

  // Condition assertions
  Schema.Struct({
    type: Schema.Literal("all_match"),
    condition: Schema.String,
    target: Schema.optional(
      Schema.Union(Schema.Literal("output"), Schema.Literal("dlq")),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("some_match"),
    condition: Schema.String,
    target: Schema.optional(
      Schema.Union(Schema.Literal("output"), Schema.Literal("dlq")),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("none_match"),
    condition: Schema.String,
    target: Schema.optional(
      Schema.Union(Schema.Literal("output"), Schema.Literal("dlq")),
    ),
  }),

  // Pipeline status assertions
  Schema.Struct({
    type: Schema.Literal("pipeline_success"),
  }),
  Schema.Struct({
    type: Schema.Literal("pipeline_failed"),
  }),
);

/**
 * Schema for test file structure
 */
const TestFileSchema = Schema.Struct({
  name: Schema.String,
  tests: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      pipeline: Schema.Struct({
        input: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
        processors: Schema.optional(
          Schema.Array(
            Schema.Record({ key: Schema.String, value: Schema.Unknown }),
          ),
        ),
        output: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
        dlq: Schema.optional(
          Schema.Struct({
            output: Schema.Record({
              key: Schema.String,
              value: Schema.Unknown,
            }),
            // Match core dlq.max_retries: non-negative integer.
            maxRetries: Schema.optional(Schema.Int.pipe(Schema.nonNegative())),
            // Match core dlq.retry_interval_ms: positive integer.
            retryDelay: Schema.optional(Schema.Int.pipe(Schema.positive())),
          }),
        ),
        backpressure: Schema.optional(
          Schema.Struct({
            // Match core max_concurrent_*: positive integer.
            concurrency: Schema.optional(Schema.Int.pipe(Schema.positive())),
          }),
        ),
      }),
      assertions: Schema.optional(Schema.Array(AssertionSchema)),
      expectError: Schema.optional(
        Schema.Struct({
          type: Schema.optional(Schema.String),
          messageContains: Schema.optional(Schema.String),
        }).pipe(
          Schema.filter((value) => {
            const hasType =
              typeof value.type === "string" && value.type.trim().length > 0;
            const hasMessage =
              typeof value.messageContains === "string" &&
              value.messageContains.trim().length > 0;
            return (
              hasType ||
              hasMessage ||
              "expectError requires a non-empty type and/or messageContains discriminator"
            );
          }),
        ),
      ),
    }),
  ),
});

/**
 * Parse error
 */
export class TestFileParseError {
  readonly _tag = "TestFileParseError";
  constructor(
    readonly path: string,
    readonly message: string,
    readonly cause?: unknown,
  ) {}
}

/**
 * Parse a YAML test file
 */
export const parseTestFile = (
  filePath: string,
): Effect.Effect<TestFile, TestFileParseError> =>
  Effect.gen(function* () {
    // Read file
    const content = yield* Effect.tryPromise({
      try: async () => await fs.readFile(filePath, "utf-8"),
      catch: (error) =>
        new TestFileParseError(
          filePath,
          `Failed to read file: ${error}`,
          error,
        ),
    });

    // Parse YAML
    const parsed = yield* Effect.try({
      try: () => yaml.parse(content),
      catch: (error) =>
        new TestFileParseError(
          filePath,
          `Failed to parse YAML: ${error}`,
          error,
        ),
    });

    // Validate structure
    const decoded = yield* Schema.decodeUnknown(TestFileSchema)(parsed).pipe(
      Effect.mapError(
        (error) =>
          new TestFileParseError(
            filePath,
            `Invalid test file structure: ${error.message}`,
            error,
          ),
      ),
    );

    return decoded;
  });

/**
 * Parse multiple test files
 */
export const parseTestFiles = (
  filePaths: readonly string[],
): Effect.Effect<readonly TestFile[], TestFileParseError> =>
  Effect.all(filePaths.map(parseTestFile));
