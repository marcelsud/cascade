/**
 * Assert Processor - Validates messages during pipeline execution
 * Used for inline assertions and message structure validation
 */
import { Effect } from "effect";
import * as Schema from "effect/Schema";
import jsonata from "jsonata";
import type { Processor, Message } from "../core/types.js";
import { ComponentError, type ErrorCategory } from "../core/errors.js";

export interface AssertProcessorConfig {
  readonly condition?: string; // JSONata expression that must evaluate to true
  readonly hasFields?: readonly string[]; // Required fields in content
  readonly error?: string; // Custom error message
  readonly logPassing?: boolean; // Log when assertions pass (default: false)
}

export const hasEffectiveAssertCheck = (
  config: AssertProcessorConfig,
): boolean =>
  (typeof config.condition === "string" &&
    config.condition.trim().length > 0) ||
  (Array.isArray(config.hasFields) &&
    config.hasFields.some(
      (field) => typeof field === "string" && field.trim().length > 0,
    ));

/**
 * Validation schema for Assert Processor configuration
 */
export const AssertProcessorConfigSchema = Schema.Struct({
  condition: Schema.optional(Schema.String),
  hasFields: Schema.optional(Schema.Array(Schema.String)),
  error: Schema.optional(Schema.String),
  logPassing: Schema.optional(Schema.Boolean),
}).pipe(
  Schema.filter(hasEffectiveAssertCheck, {
    message: () =>
      "Assert Processor requires at least one effective check: a non-blank 'condition' or at least one non-blank 'hasFields' path.",
  }),
);

export class AssertProcessorConfigError extends Error {
  readonly _tag = "AssertProcessorConfigError";

  constructor(message: string) {
    super(message);
    this.name = "AssertProcessorConfigError";
  }
}

export class AssertProcessorError extends ComponentError {
  readonly _tag = "AssertProcessorError";
  readonly category: ErrorCategory = "logical";

  constructor(message: string, cause?: unknown) {
    super(message, cause);
  }
}

/**
 * Check if object has nested field using dot notation
 */
const hasNestedField = (obj: unknown, path: string): boolean => {
  if (obj === null || obj === undefined) return false;

  const parts = path.split(".");
  let current: any = obj;

  for (const part of parts) {
    if (typeof current !== "object" || current === null || !(part in current)) {
      return false;
    }
    current = current[part];
  }

  return current !== undefined;
};

/**
 * Create Assert Processor
 *
 * Validates messages during pipeline execution. Fails the pipeline
 * if assertions don't pass.
 *
 * @example
 * ```typescript
 * const processor = createAssertProcessor({
 *   condition: 'content.amount > 0',
 *   hasFields: ['id', 'content.type'],
 *   error: 'Invalid message structure'
 * })
 * ```
 */
export const createAssertProcessor = (
  config: AssertProcessorConfig = {},
): Processor<AssertProcessorError> => {
  if (!hasEffectiveAssertCheck(config)) {
    throw new AssertProcessorConfigError(
      "Assert Processor requires at least one effective check: a non-blank 'condition' or at least one non-blank 'hasFields' path.",
    );
  }

  const {
    condition,
    hasFields,
    error: customError,
    logPassing = false,
  } = config;

  // Pre-compile JSONata expression for performance
  const compiledExpression = condition ? jsonata(condition) : null;

  return {
    name: "assert-processor",

    process: (message: Message): Effect.Effect<Message, AssertProcessorError> =>
      Effect.gen(function* () {
        // Check required fields
        if (hasFields && hasFields.length > 0) {
          for (const field of hasFields) {
            const hasField = hasNestedField(message.content, field);
            if (!hasField) {
              const errorMsg =
                customError ?? `Assertion failed: Missing field '${field}'`;
              return yield* Effect.fail(
                new AssertProcessorError(
                  `${errorMsg} (messageId: ${message.id})`,
                  new Error(`Field '${field}' not found in message content`),
                ),
              );
            }
          }
        }

        // Check JSONata condition
        if (compiledExpression) {
          const result = yield* Effect.tryPromise({
            try: async () => await compiledExpression.evaluate(message),
            catch: (error) =>
              new AssertProcessorError(
                `Failed to evaluate condition: ${condition}`,
                error,
              ),
          });

          if (!result) {
            const errorMsg =
              customError ??
              `Assertion failed: Condition '${condition}' evaluated to false`;
            return yield* Effect.fail(
              new AssertProcessorError(
                `${errorMsg} (messageId: ${message.id})`,
              ),
            );
          }
        }

        // Log if passing and configured
        if (logPassing) {
          yield* Effect.logDebug(`Assertion passed for message: ${message.id}`);
        }

        // Pass through message unchanged
        return message;
      }),
  };
};
