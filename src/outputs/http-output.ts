/**
 * HTTP Output - Sends messages via HTTP/HTTPS requests
 */
import { Effect, Schedule } from "effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "@effect/platform";
import { NodeHttpClient } from "@effect/platform-node";
import type { Output, Message } from "../core/types.js";
import {
  ComponentError,
  type ErrorCategory,
  detectCategory,
} from "../core/errors.js";
import {
  MetricsAccumulator,
  emitOutputMetrics,
  measureDuration,
} from "../core/metrics.js";
import {
  validate,
  NonEmptyString,
  TimeoutMs,
  RetryCount,
} from "../core/validation.js";

export interface HttpOutputConfig {
  readonly url: string;
  readonly method?: "POST" | "PUT" | "PATCH";
  readonly headers?: Record<string, string>;
  readonly timeout?: number; // Timeout in milliseconds
  readonly maxRetries?: number; // Retry count (default 3)
  readonly auth?: {
    readonly type: "basic" | "bearer";
    readonly username?: string;
    readonly password?: string;
    readonly token?: string;
  };
}

export class HttpOutputError extends ComponentError {
  readonly _tag = "HttpOutputError";

  constructor(
    message: string,
    readonly category: ErrorCategory,
    cause?: unknown,
  ) {
    super(message, cause);
  }
}

/**
 * HTTP Method schema
 */
const HttpMethod = Schema.Union(
  Schema.Literal("POST"),
  Schema.Literal("PUT"),
  Schema.Literal("PATCH"),
);

/**
 * HTTP URL schema
 */
const HttpUrl = Schema.String.pipe(
  Schema.pattern(/^https?:\/\/.+/, {
    message: () => "Must be a valid HTTP or HTTPS URL",
  }),
);

/**
 * Validation schema for HTTP Output configuration
 */
export const HttpOutputConfigSchema = Schema.Struct({
  url: HttpUrl,
  method: Schema.optional(HttpMethod),
  headers: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.String }),
  ),
  timeout: Schema.optional(TimeoutMs),
  maxRetries: Schema.optional(RetryCount),
  auth: Schema.optional(
    Schema.Struct({
      type: Schema.Union(Schema.Literal("basic"), Schema.Literal("bearer")),
      username: Schema.optional(NonEmptyString),
      password: Schema.optional(NonEmptyString),
      token: Schema.optional(NonEmptyString),
    }),
  ),
});

/**
 * Serialize Message to HTTP request body
 */
const serializeMessage = (msg: Message): string => {
  return JSON.stringify({
    id: msg.id,
    timestamp: msg.timestamp,
    correlationId: msg.correlationId,
    metadata: msg.metadata,
    content: msg.content,
    trace: msg.trace,
  });
};

/**
 * Build authentication headers
 */
const buildAuthHeaders = (
  auth?: HttpOutputConfig["auth"],
): Record<string, string> => {
  if (!auth) return {};

  if (auth.type === "bearer") {
    if (!auth.token) {
      throw new Error("Bearer token required for bearer authentication");
    }
    return {
      Authorization: `Bearer ${auth.token}`,
    };
  }

  if (auth.type === "basic") {
    if (!auth.username || !auth.password) {
      throw new Error(
        "Username and password required for basic authentication",
      );
    }
    const credentials = Buffer.from(
      `${auth.username}:${auth.password}`,
    ).toString("base64");
    return {
      Authorization: `Basic ${credentials}`,
    };
  }

  return {};
};

/**
 * Detect error category from HTTP response
 */
const detectHttpErrorCategory = (error: unknown): ErrorCategory => {
  // Check if it's an HTTP client error
  if (error && typeof error === "object" && "_tag" in error) {
    const tag = (error as any)._tag;
    if (tag === "RequestError" || tag === "Transport") {
      // Network errors, connection refused, etc.
      return "intermittent";
    }
    if (tag === "StatusCode") {
      const status = (error as any).status || 0;
      if (status >= 500) {
        // 5xx errors are server errors, retry
        return "intermittent";
      }
      if (status >= 400 && status < 500) {
        // 4xx errors are client errors, don't retry
        return "logical";
      }
    }
  }
  return detectCategory(error);
};

/**
 * Create HTTP Output component
 *
 * @param config - HTTP output configuration
 * @returns Output component that sends messages via HTTP
 *
 * @example
 * ```typescript
 * const output = createHttpOutput({
 *   url: "https://webhook.site/74ed15d1-ebfe-4c99-be1b-751e821e084a",
 *   method: "POST",
 *   headers: { "Content-Type": "application/json" },
 *   maxRetries: 3,
 *   auth: {
 *     type: "bearer",
 *     token: process.env.API_TOKEN
 *   }
 * })
 * ```
 */
export const createHttpOutput = (
  config: HttpOutputConfig,
): Output<HttpOutputError> => {
  // Validate configuration synchronously
  Effect.runSync(
    validate(HttpOutputConfigSchema, config, "HTTP Output configuration").pipe(
      Effect.catchAll((error) => Effect.die(error)),
    ),
  );

  const method = config.method ?? "POST";
  const maxRetries = config.maxRetries ?? 3;
  const timeout = config.timeout ?? 30000; // 30 seconds default

  // Setup metrics
  const metrics = new MetricsAccumulator("http-output");

  // Build headers
  const authHeaders = buildAuthHeaders(config.auth);
  const customHeaders = config.headers ?? {};
  const headers = {
    "Content-Type": "application/json",
    ...customHeaders,
    ...authHeaders,
  };

  Effect.runSync(
    Effect.log(`HTTP Output initialized: ${method} ${config.url}`),
  );

  // Emit metrics every 100 sends
  let sendCount = 0;
  const maybeEmitMetrics = (): Effect.Effect<void, never> =>
    Effect.gen(function* () {
      sendCount++;
      if (sendCount % 100 === 0) {
        yield* emitOutputMetrics(metrics.getOutputMetrics());
      }
    });

  // Create HTTP client layer
  const clientLayer = NodeHttpClient.layer;

  return {
    name: "http-output",

    send: (message: Message): Effect.Effect<void, HttpOutputError, never> =>
      Effect.gen(function* () {
        const body = serializeMessage(message);

        const httpRequest = HttpClientRequest.make(method)(config.url).pipe(
          HttpClientRequest.setHeaders(headers),
          HttpClientRequest.bodyText(body),
          HttpClientRequest.setHeaders({
            "User-Agent": "cascade/0.1.1",
          }),
        );

        const [_, duration] = yield* measureDuration(
          Effect.gen(function* () {
            const client = yield* HttpClient.HttpClient;

            const response = yield* client.execute(httpRequest).pipe(
              Effect.timeout(`${timeout} millis`),
              Effect.retry({
                times: maxRetries,
                schedule: Schedule.exponential("1 second"),
              }),
              Effect.catchAll((error) => {
                const category = detectHttpErrorCategory(error);
                const errorMessage =
                  error instanceof Error ? error.message : String(error);
                return Effect.fail(
                  new HttpOutputError(
                    `Failed to send HTTP ${method} request to ${config.url}: ${errorMessage}`,
                    category,
                    error,
                  ),
                );
              }),
            );

            // Check response status
            if (response.status >= 400) {
              const category =
                response.status >= 500 ? "intermittent" : "logical";
              return yield* Effect.fail(
                new HttpOutputError(
                  `HTTP ${method} request failed with status ${response.status}`,
                  category,
                ),
              );
            }
          }),
        );

        metrics.recordSent(1, duration);
        yield* maybeEmitMetrics();
      }).pipe(Effect.provide(clientLayer)),

    close: (): Effect.Effect<void, never> =>
      Effect.gen(function* () {
        yield* Effect.log("HTTP Output closing");
        yield* emitOutputMetrics(metrics.getOutputMetrics());
      }),
  };
};
