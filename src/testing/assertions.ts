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
 * Deep equality check for plain objects and arrays.
 * Both values are known non-null objects with matching typeof.
 */
const deepEqualObjects = (a: object, b: object): boolean => {
  if (Array.isArray(a) && Array.isArray(b)) {
    return (
      a.length === b.length && a.every((val, idx) => deepEqual(val, b[idx]))
    );
  }

  const recordA = a as Record<string, unknown>;
  const recordB = b as Record<string, unknown>;
  const keysA = Object.keys(recordA);
  const keysB = Object.keys(recordB);
  return (
    keysA.length === keysB.length &&
    keysA.every((key) => deepEqual(recordA[key], recordB[key]))
  );
};

/**
 * Deep equality check. Uses === for primitives (NaN unequal, +0 === -0).
 */
const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (a === undefined || b === undefined) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a === "object") {
    return deepEqualObjects(a as object, b as object);
  }
  return false;
};

/**
 * Execute a single assertion
 */
const assertionResult = (
  passed: boolean,
  message: string,
  assertion: Assertion,
): AssertionResult => ({ passed, message, assertion });

const resolveAssertionMessages = (
  assertion: Assertion,
  context: AssertionContext,
): readonly Message[] => {
  const target =
    "target" in assertion ? (assertion.target ?? "output") : "output";
  return target === "dlq"
    ? (context.dlqMessages ?? [])
    : context.outputMessages;
};

const evaluateMatchResults = (
  messages: readonly Message[],
  condition: string,
): Effect.Effect<unknown[], Error> => {
  const expression = jsonata(condition);
  return Effect.all(
    messages.map((msg) =>
      Effect.tryPromise({
        try: async () => await expression.evaluate(msg),
        catch: (error) => new Error(`JSONata evaluation failed: ${error}`),
      }),
    ),
  );
};

const assertMessageCount = (
  assertion:
    | MessageCountAssertion
    | MessageCountLessThanAssertion
    | MessageCountGreaterThanAssertion,
  messages: readonly Message[],
): AssertionResult => {
  const actual = messages.length;
  const expected = assertion.expected;

  if (assertion.type === "message_count") {
    const passed = actual === expected;
    return assertionResult(
      passed,
      passed
        ? `✓ Message count is ${actual}`
        : `✗ Expected ${expected} messages, got ${actual}`,
      assertion,
    );
  }

  if (assertion.type === "message_count_less_than") {
    const passed = actual < expected;
    return assertionResult(
      passed,
      passed
        ? `✓ Message count ${actual} < ${expected}`
        : `✗ Expected < ${expected} messages, got ${actual}`,
      assertion,
    );
  }

  const passed = actual > expected;
  return assertionResult(
    passed,
    passed
      ? `✓ Message count ${actual} > ${expected}`
      : `✗ Expected > ${expected} messages, got ${actual}`,
    assertion,
  );
};

const assertIndexedField = (
  assertion: FieldValueAssertion | FieldExistsAssertion,
  messages: readonly Message[],
): AssertionResult => {
  const messageIndex = assertion.message;
  if (messageIndex >= messages.length) {
    return assertionResult(
      false,
      `✗ Message ${messageIndex} does not exist (only ${messages.length} messages)`,
      assertion,
    );
  }

  const message = messages[messageIndex];
  if (assertion.type === "field_exists") {
    const value = getNestedValue(message, assertion.path);
    const passed = value !== undefined;
    return assertionResult(
      passed,
      passed
        ? `✓ Message[${messageIndex}].${assertion.path} exists`
        : `✗ Field ${assertion.path} does not exist`,
      assertion,
    );
  }

  const actual = getNestedValue(message, assertion.path);
  const expected = assertion.expected;
  const passed = deepEqual(actual, expected);
  return assertionResult(
    passed,
    passed
      ? `✓ Message[${messageIndex}].${assertion.path} = ${JSON.stringify(expected)}`
      : `✗ Expected ${assertion.path} to be ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    assertion,
  );
};

const assertMatchCondition = (
  assertion: AllMatchAssertion | SomeMatchAssertion | NoneMatchAssertion,
  messages: readonly Message[],
): Effect.Effect<AssertionResult, Error> =>
  Effect.gen(function* () {
    if (messages.length === 0) {
      if (assertion.type === "none_match") {
        return assertionResult(true, `✓ No messages (none match)`, assertion);
      }
      return assertionResult(
        false,
        `✗ No messages to match against`,
        assertion,
      );
    }

    const results = yield* evaluateMatchResults(messages, assertion.condition);
    const matchCount = results.filter((result) => result === true).length;

    if (assertion.type === "all_match") {
      const passed = matchCount === messages.length;
      return assertionResult(
        passed,
        passed
          ? `✓ All ${messages.length} messages match condition`
          : `✗ Not all messages match: ${assertion.condition}`,
        assertion,
      );
    }

    if (assertion.type === "some_match") {
      const passed = matchCount > 0;
      return assertionResult(
        passed,
        passed
          ? `✓ ${matchCount} message(s) match condition`
          : `✗ No messages match: ${assertion.condition}`,
        assertion,
      );
    }

    const passed = matchCount === 0;
    return assertionResult(
      passed,
      passed
        ? `✓ None of ${messages.length} messages match`
        : `✗ ${matchCount} message(s) match (expected none): ${assertion.condition}`,
      assertion,
    );
  });

const assertPipelineOutcome = (
  assertion: PipelineSuccessAssertion | PipelineFailedAssertion,
  context: AssertionContext,
): AssertionResult => {
  if (assertion.type === "pipeline_success") {
    const passed = context.pipelineSuccess;
    return assertionResult(
      passed,
      passed
        ? `✓ Pipeline completed successfully`
        : `✗ Pipeline failed: ${context.pipelineError}`,
      assertion,
    );
  }

  const passed = !context.pipelineSuccess;
  return assertionResult(
    passed,
    passed
      ? `✓ Pipeline failed as expected`
      : `✗ Expected pipeline to fail but it succeeded`,
    assertion,
  );
};

const executeAssertion = (
  assertion: Assertion,
  context: AssertionContext,
): Effect.Effect<AssertionResult, Error> =>
  Effect.gen(function* () {
    const messages = resolveAssertionMessages(assertion, context);

    switch (assertion.type) {
      case "message_count":
      case "message_count_less_than":
      case "message_count_greater_than":
        return assertMessageCount(assertion, messages);

      case "field_value":
      case "field_exists":
        return assertIndexedField(assertion, messages);

      case "all_match":
      case "some_match":
      case "none_match":
        return yield* assertMatchCondition(assertion, messages);

      case "pipeline_success":
      case "pipeline_failed":
        return assertPipelineOutcome(assertion, context);

      default:
        return assertionResult(false, `✗ Unknown assertion type`, assertion);
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
