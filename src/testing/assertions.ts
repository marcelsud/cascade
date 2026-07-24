/**
 * Assertion Engine for YAML Test Runner
 *
 * Provides assertion types and execution for validating pipeline results
 */
import { Effect } from "effect";
import jsonata from "jsonata";
import type { Message } from "../core/types.js";

/**
 * Assertion result
 */
export interface AssertionResult {
  readonly passed: boolean;
  readonly message: string;
  readonly assertion: Assertion;
}

/**
 * Supported assertion types
 */
export type Assertion =
  | MessageCountAssertion
  | MessageCountLessThanAssertion
  | MessageCountGreaterThanAssertion
  | FieldValueAssertion
  | FieldExistsAssertion
  | AllMatchAssertion
  | SomeMatchAssertion
  | NoneMatchAssertion
  | PipelineSuccessAssertion
  | PipelineFailedAssertion;

interface MessageCountAssertion {
  readonly type: "message_count";
  readonly expected: number;
  readonly target?: "output" | "dlq";
}

interface MessageCountLessThanAssertion {
  readonly type: "message_count_less_than";
  readonly expected: number;
  readonly target?: "output" | "dlq";
}

interface MessageCountGreaterThanAssertion {
  readonly type: "message_count_greater_than";
  readonly expected: number;
  readonly target?: "output" | "dlq";
}

interface FieldValueAssertion {
  readonly type: "field_value";
  readonly message: number; // Message index
  readonly path: string; // Dot notation: "content.user.name"
  readonly expected: unknown;
  readonly target?: "output" | "dlq";
}

interface FieldExistsAssertion {
  readonly type: "field_exists";
  readonly message: number;
  readonly path: string;
  readonly target?: "output" | "dlq";
}

interface AllMatchAssertion {
  readonly type: "all_match";
  readonly condition: string; // JSONata expression
  readonly target?: "output" | "dlq";
}

interface SomeMatchAssertion {
  readonly type: "some_match";
  readonly condition: string;
  readonly target?: "output" | "dlq";
}

interface NoneMatchAssertion {
  readonly type: "none_match";
  readonly condition: string;
  readonly target?: "output" | "dlq";
}

interface PipelineSuccessAssertion {
  readonly type: "pipeline_success";
}

interface PipelineFailedAssertion {
  readonly type: "pipeline_failed";
}

/**
 * Context for running assertions
 */
export interface AssertionContext {
  readonly outputMessages: readonly Message[];
  readonly dlqMessages?: readonly Message[];
  readonly pipelineSuccess: boolean;
  readonly pipelineError?: unknown;
}

/**
 * Get nested field value using dot notation
 */
const getNestedValue = (obj: any, path: string): any => {
  const parts = path.split(".");
  let current = obj;

  for (const part of parts) {
    if (
      current === null ||
      current === undefined ||
      typeof current !== "object"
    ) {
      return undefined;
    }
    current = current[part];
  }

  return current;
};

/**
 * Deep equality check
 */
const deepEqual = (a: any, b: any): boolean => {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (a === undefined || b === undefined) return false;
  if (typeof a !== typeof b) return false;

  if (typeof a === "object") {
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      return a.every((val, idx) => deepEqual(val, b[idx]));
    }

    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;

    return keysA.every((key) => deepEqual(a[key], b[key]));
  }

  return false;
};

/**
 * Execute a single assertion
 */
const executeAssertion = (
  assertion: Assertion,
  context: AssertionContext,
): Effect.Effect<AssertionResult, Error> =>
  Effect.gen(function* () {
    const target =
      "target" in assertion ? (assertion.target ?? "output") : "output";
    const messages =
      target === "dlq" ? (context.dlqMessages ?? []) : context.outputMessages;

    switch (assertion.type) {
      case "message_count": {
        const actual = messages.length;
        const expected = assertion.expected;
        const passed = actual === expected;

        return {
          passed,
          message: passed
            ? `✓ Message count is ${actual}`
            : `✗ Expected ${expected} messages, got ${actual}`,
          assertion,
        };
      }

      case "message_count_less_than": {
        const actual = messages.length;
        const expected = assertion.expected;
        const passed = actual < expected;

        return {
          passed,
          message: passed
            ? `✓ Message count ${actual} < ${expected}`
            : `✗ Expected < ${expected} messages, got ${actual}`,
          assertion,
        };
      }

      case "message_count_greater_than": {
        const actual = messages.length;
        const expected = assertion.expected;
        const passed = actual > expected;

        return {
          passed,
          message: passed
            ? `✓ Message count ${actual} > ${expected}`
            : `✗ Expected > ${expected} messages, got ${actual}`,
          assertion,
        };
      }

      case "field_value": {
        const messageIndex = assertion.message;
        if (messageIndex >= messages.length) {
          return {
            passed: false,
            message: `✗ Message ${messageIndex} does not exist (only ${messages.length} messages)`,
            assertion,
          };
        }

        const message = messages[messageIndex];
        const actual = getNestedValue(message, assertion.path);
        const expected = assertion.expected;
        const passed = deepEqual(actual, expected);

        return {
          passed,
          message: passed
            ? `✓ Message[${messageIndex}].${assertion.path} = ${JSON.stringify(expected)}`
            : `✗ Expected ${assertion.path} to be ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
          assertion,
        };
      }

      case "field_exists": {
        const messageIndex = assertion.message;
        if (messageIndex >= messages.length) {
          return {
            passed: false,
            message: `✗ Message ${messageIndex} does not exist (only ${messages.length} messages)`,
            assertion,
          };
        }

        const message = messages[messageIndex];
        const value = getNestedValue(message, assertion.path);
        const passed = value !== undefined;

        return {
          passed,
          message: passed
            ? `✓ Message[${messageIndex}].${assertion.path} exists`
            : `✗ Field ${assertion.path} does not exist`,
          assertion,
        };
      }

      case "all_match": {
        if (messages.length === 0) {
          return {
            passed: false,
            message: `✗ No messages to match against`,
            assertion,
          };
        }

        const expression = jsonata(assertion.condition);
        const results = yield* Effect.all(
          messages.map((msg) =>
            Effect.tryPromise({
              try: async () => await expression.evaluate(msg),
              catch: (error) =>
                new Error(`JSONata evaluation failed: ${error}`),
            }),
          ),
        );

        const passed = results.every((result) => result === true);

        return {
          passed,
          message: passed
            ? `✓ All ${messages.length} messages match condition`
            : `✗ Not all messages match: ${assertion.condition}`,
          assertion,
        };
      }

      case "some_match": {
        if (messages.length === 0) {
          return {
            passed: false,
            message: `✗ No messages to match against`,
            assertion,
          };
        }

        const expression = jsonata(assertion.condition);
        const results = yield* Effect.all(
          messages.map((msg) =>
            Effect.tryPromise({
              try: async () => await expression.evaluate(msg),
              catch: (error) =>
                new Error(`JSONata evaluation failed: ${error}`),
            }),
          ),
        );

        const matchCount = results.filter((result) => result === true).length;
        const passed = matchCount > 0;

        return {
          passed,
          message: passed
            ? `✓ ${matchCount} message(s) match condition`
            : `✗ No messages match: ${assertion.condition}`,
          assertion,
        };
      }

      case "none_match": {
        if (messages.length === 0) {
          return {
            passed: true,
            message: `✓ No messages (none match)`,
            assertion,
          };
        }

        const expression = jsonata(assertion.condition);
        const results = yield* Effect.all(
          messages.map((msg) =>
            Effect.tryPromise({
              try: async () => await expression.evaluate(msg),
              catch: (error) =>
                new Error(`JSONata evaluation failed: ${error}`),
            }),
          ),
        );

        const matchCount = results.filter((result) => result === true).length;
        const passed = matchCount === 0;

        return {
          passed,
          message: passed
            ? `✓ None of ${messages.length} messages match`
            : `✗ ${matchCount} message(s) match (expected none): ${assertion.condition}`,
          assertion,
        };
      }

      case "pipeline_success": {
        const passed = context.pipelineSuccess;

        return {
          passed,
          message: passed
            ? `✓ Pipeline completed successfully`
            : `✗ Pipeline failed: ${context.pipelineError}`,
          assertion,
        };
      }

      case "pipeline_failed": {
        const passed = !context.pipelineSuccess;

        return {
          passed,
          message: passed
            ? `✓ Pipeline failed as expected`
            : `✗ Expected pipeline to fail but it succeeded`,
          assertion,
        };
      }

      default: {
        return {
          passed: false,
          message: `✗ Unknown assertion type`,
          assertion,
        };
      }
    }
  });

/**
 * Execute all assertions for a test
 */
export const executeAssertions = (
  assertions: readonly Assertion[],
  context: AssertionContext,
): Effect.Effect<readonly AssertionResult[], Error> =>
  Effect.all(
    assertions.map((assertion) => executeAssertion(assertion, context)),
  );
