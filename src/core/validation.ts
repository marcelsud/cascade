/**
 * Configuration validation using Effect Schema
 */
import * as Schema from "effect/Schema";
import { Effect } from "effect";
import { ComponentError, type ErrorCategory } from "./errors.js";

export class ValidationError extends ComponentError {
  readonly _tag = "ValidationError";
  readonly category: ErrorCategory = "logical";

  constructor(message: string, cause?: unknown) {
    super(message, cause);
  }
}

/**
 * Validate a value against a schema
 */
export const validate = <A, I>(
  schema: Schema.Codec<A, I>,
  value: unknown,
  context: string,
): Effect.Effect<A, ValidationError> =>
  Effect.gen(function* () {
    const result = yield* Schema.decodeUnknownEffect(schema)(value).pipe(
      Effect.mapError((error) => {
        const message = `Invalid ${context}: ${error.message}`;
        return new ValidationError(message, error);
      }),
    );
    return result;
  });

/**
 * Common validation schemas
 */

// Positive integer
export const PositiveInt = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThan(0)),
);

// Port number (1-65535)
export const Port = Schema.Int.pipe(
  Schema.check(
    Schema.isBetween(
      { minimum: 1, maximum: 65535 },
      {
        message: "Port must be between 1 and 65535",
      },
    ),
  ),
);

// Non-empty string
export const NonEmptyString = Schema.String.pipe(
  Schema.check(
    Schema.isMinLength(1, {
      message: "String cannot be empty",
    }),
  ),
);

// URL string
export const UrlString = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^https?:\/\/.+/, {
      message: "Must be a valid HTTP or HTTPS URL",
    }),
  ),
);

// Hostname
export const Hostname = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(
      /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/,
      {
        message: "Must be a valid hostname",
      },
    ),
  ),
);

// AWS Region
export const AwsRegion = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^[a-z]{2}-[a-z]+-\d+$/, {
      message: "Must be a valid AWS region (e.g., us-east-1)",
    }),
  ),
);

// Positive timeout in milliseconds
export const TimeoutMs = Schema.Int.pipe(
  Schema.check(
    Schema.isGreaterThan(0, {
      message: "Timeout must be a positive number",
    }),
  ),
);

// Batch size (1-10 for SQS)
export const SqsBatchSize = Schema.Int.pipe(
  Schema.check(
    Schema.isBetween(
      { minimum: 1, maximum: 10 },
      {
        message: "SQS batch size must be between 1 and 10",
      },
    ),
  ),
);

// SQS max messages per receive (1-10)
export const SqsMaxMessages = Schema.Int.pipe(
  Schema.check(
    Schema.isBetween(
      { minimum: 1, maximum: 10 },
      {
        message: "Max messages must be between 1 and 10",
      },
    ),
  ),
);

// Retry count (0-10)
export const RetryCount = Schema.Int.pipe(
  Schema.check(
    Schema.isBetween(
      { minimum: 0, maximum: 10 },
      {
        message: "Retry count must be between 0 and 10",
      },
    ),
  ),
);
