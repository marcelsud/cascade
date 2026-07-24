/**
 * Core error types with categorization
 * Errors are categorized to determine handling strategy:
 * - intermittent: Network/connectivity issues, should retry
 * - logical: Bad data/config, log and continue
 * - fatal: Critical failures, stop immediately
 */

export type ErrorCategory = "intermittent" | "logical" | "fatal";

/**
 * Base error class for all components
 */
export abstract class ComponentError extends Error {
  abstract readonly _tag: string;
  abstract readonly category: ErrorCategory;

  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = this.constructor.name;

    // Maintain proper stack trace for where our error was thrown (only in V8)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  /**
   * Check if error should be retried
   */
  get shouldRetry(): boolean {
    return this.category === "intermittent";
  }

  /**
   * Check if error is fatal (should stop pipeline)
   */
  get isFatal(): boolean {
    return this.category === "fatal";
  }

  /**
   * Get appropriate log level for this error
   */
  get logLevel(): "debug" | "info" | "error" {
    switch (this.category) {
      case "intermittent":
        return "error"; // Network errors are serious
      case "logical":
        return "debug"; // Bad data is expected, debug level
      case "fatal":
        return "error"; // Fatal errors are critical
    }
  }
}

/**
 * Create error with automatic categorization
 */
export function createCategorizedError<T extends ComponentError>(
  ErrorClass: new (
    message: string,
    category: ErrorCategory,
    cause?: unknown,
  ) => T,
  message: string,
  cause?: unknown,
): T {
  // Auto-detect category based on error cause
  const category = detectCategory(cause);
  return new ErrorClass(message, category, cause);
}

/**
 * Detect error category from cause
 */
export function detectCategory(cause: unknown): ErrorCategory {
  if (!cause) return "intermittent";

  const errorMessage = cause instanceof Error ? cause.message : String(cause);
  const lowerMessage = errorMessage.toLowerCase();

  // Network/connectivity errors (intermittent)
  if (
    lowerMessage.includes("network") ||
    lowerMessage.includes("timeout") ||
    lowerMessage.includes("econnrefused") ||
    lowerMessage.includes("enotfound") ||
    lowerMessage.includes("etimedout") ||
    lowerMessage.includes("socket") ||
    lowerMessage.includes("connection")
  ) {
    return "intermittent";
  }

  // Parse/validation errors (logical)
  if (
    lowerMessage.includes("parse") ||
    lowerMessage.includes("invalid json") ||
    lowerMessage.includes("validation") ||
    lowerMessage.includes("schema") ||
    lowerMessage.includes("unexpected token")
  ) {
    return "logical";
  }

  // Missing config/critical errors (fatal)
  if (
    lowerMessage.includes("required") ||
    lowerMessage.includes("missing") ||
    lowerMessage.includes("not configured") ||
    lowerMessage.includes("unauthorized")
  ) {
    return "fatal";
  }

  // Default to intermittent (safe default - will retry)
  return "intermittent";
}

const isErrorCategory = (value: unknown): value is ErrorCategory =>
  value === "intermittent" || value === "logical" || value === "fatal";

/**
 * Resolve the handling category for any thrown/failed value.
 * Explicit `category` on the error object wins; otherwise fall back to
 * {@link detectCategory}.
 */
export function getErrorCategory(error: unknown): ErrorCategory {
  if (error !== null && typeof error === "object" && "category" in error) {
    const category = error.category;
    if (isErrorCategory(category)) {
      return category;
    }
  }
  return detectCategory(error);
}

/** True when the error should be retried (intermittent only). */
export function isIntermittentError(error: unknown): boolean {
  return getErrorCategory(error) === "intermittent";
}

/** True when the error should halt pipeline intake. */
export function isFatalError(error: unknown): boolean {
  return getErrorCategory(error) === "fatal";
}
