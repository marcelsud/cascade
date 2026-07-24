/**
 * HTTP Processor - Makes HTTP requests to enrich/validate messages
 * Supports JSONata templating for URLs and request bodies
 */
import { Effect, Schedule } from "effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "@effect/platform";
import { NodeHttpClient } from "@effect/platform-node";
import jsonata from "jsonata";
import type { Processor, Message } from "../core/types.js";
import {
  ComponentError,
  type ErrorCategory,
  detectCategory,
} from "../core/errors.js";
import {
  validate,
  NonEmptyString,
  TimeoutMs,
  RetryCount,
} from "../core/validation.js";

export interface HttpProcessorConfig {
  readonly url: string; // JSONata template: "https://api.com/users/{{ content.userId }}"
  readonly method?: "GET" | "POST" | "PUT" | "PATCH";
  readonly headers?: Record<string, string>;
  readonly body?: string; // JSONata expression for request body
  readonly resultKey?: string; // Where to store response (default: "http_response")
  readonly resultMapping?: string; // Optional JSONata to map response into content
  readonly timeout?: number; // Timeout in milliseconds
  readonly maxRetries?: number; // Retry count (default 3)
  readonly auth?: {
    readonly type: "basic" | "bearer";
    readonly username?: string;
    readonly password?: string;
    readonly token?: string;
  };
}

export class HttpProcessorError extends ComponentError {
  readonly _tag = "HttpProcessorError";

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
  Schema.Literal("GET"),
  Schema.Literal("POST"),
  Schema.Literal("PUT"),
  Schema.Literal("PATCH"),
);

/**
 * Validation schema for HTTP Processor configuration
 */
export const HttpProcessorConfigSchema = Schema.Struct({
  url: NonEmptyString,
  method: Schema.optional(HttpMethod),
  headers: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.String }),
  ),
  body: Schema.optional(NonEmptyString),
  resultKey: Schema.optional(NonEmptyString),
  resultMapping: Schema.optional(NonEmptyString),
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
 * Evaluate JSONata template with message context
 * Templates use {{ }} syntax: "https://api.com/users/{{ content.userId }}"
 */
const evaluateTemplate = (
  template: string,
  msg: Message,
): Effect.Effect<string, HttpProcessorError> =>
  Effect.gen(function* () {
    // Extract JSONata expressions from {{ }} and evaluate each one
    const evaluatedTemplate = yield* Effect.tryPromise({
      try: async () => {
        // Replace {{ expr }} with evaluated values
        let result = template;
        const regex = /\{\{(.+?)\}\}/g;
        const matches = [...template.matchAll(regex)];

        for (const match of matches) {
          const expr = match[1].trim();
          const expression = jsonata(expr);
          const value = await expression.evaluate(
            {},
            {
              content: msg.content,
              meta: msg.metadata,
              message: {
                id: msg.id,
                timestamp: msg.timestamp,
                correlationId: msg.correlationId,
              },
            },
          );
          result = result.replace(match[0], String(value));
        }

        return result;
      },
      catch: (error) =>
        new HttpProcessorError(
          `Failed to evaluate template: ${error instanceof Error ? error.message : String(error)}`,
          "logical",
          error,
        ),
    });

    return evaluatedTemplate;
  });

/**
 * Build authentication headers
 */
const buildAuthHeaders = (
  auth?: HttpProcessorConfig["auth"],
): Record<string, string> => {
  if (!auth) return {};

  if (auth.type === "bearer") {
    if (!auth.token) {
      throw new HttpProcessorError(
        "Bearer token required for bearer authentication",
        "fatal",
      );
    }
    return {
      Authorization: `Bearer ${auth.token}`,
    };
  }

  if (auth.type === "basic") {
    if (!auth.username || !auth.password) {
      throw new HttpProcessorError(
        "Username and password required for basic authentication",
        "fatal",
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
  if (error && typeof error === "object" && "_tag" in error) {
    const tag = (error as any)._tag;

    // Network/transport errors - retry
    if (tag === "RequestError" || tag === "Transport") {
      return "intermittent";
    }

    // Status code errors
    if (tag === "StatusCode") {
      const status = (error as any).status;
      if (status >= 500) return "intermittent"; // 5xx - retry
      if (status === 429) return "intermittent"; // Rate limit - retry
      if (status >= 400) return "logical"; // 4xx - don't retry
    }
  }

  // Use default detection
  return detectCategory(error);
};

/**
 * Create an HTTP processor
 */
export const createHttpProcessor = (
  config: HttpProcessorConfig,
): Processor<HttpProcessorError> => {
  // Validate configuration synchronously at creation time
  Effect.runSync(
    validate(
      HttpProcessorConfigSchema,
      config,
      "HTTP Processor configuration",
    ).pipe(
      Effect.catchAll((error) =>
        Effect.fail(
          new HttpProcessorError(error.message, error.category, error),
        ),
      ),
    ),
  );

  const method = config.method ?? "GET";
  const timeout = config.timeout ?? 30000;
  const maxRetries = config.maxRetries ?? 3;
  const resultKey = config.resultKey ?? "http_response";

  // Build static headers (auth + custom)
  const authHeaders = buildAuthHeaders(config.auth);
  const customHeaders = config.headers ?? {};
  const staticHeaders = {
    ...authHeaders,
    ...customHeaders,
  };

  // Compile result mapping if provided
  let compiledResultMapping: ReturnType<typeof jsonata> | undefined;
  if (config.resultMapping) {
    try {
      compiledResultMapping = jsonata(config.resultMapping);
    } catch (error) {
      throw new HttpProcessorError(
        `Failed to compile result mapping: ${error instanceof Error ? error.message : String(error)}`,
        "fatal",
        error,
      );
    }
  }

  return {
    name: "http-processor",
    process: (msg: Message): Effect.Effect<Message, HttpProcessorError> => {
      return Effect.gen(function* () {
        // Evaluate URL template
        const url = yield* evaluateTemplate(config.url, msg);

        yield* Effect.logDebug(`HTTP Processor: ${method} ${url}`);

        // Evaluate request body if provided
        let requestBody: string | undefined;
        if (
          config.body &&
          (method === "POST" || method === "PUT" || method === "PATCH")
        ) {
          requestBody = yield* evaluateTemplate(config.body, msg);
        }

        // Build HTTP request
        const client = yield* HttpClient.HttpClient.pipe(
          Effect.provide(NodeHttpClient.layer),
        );

        const baseRequest = HttpClientRequest.make(method)(url).pipe(
          HttpClientRequest.setHeaders(staticHeaders),
        );

        // Add body if present
        const request = requestBody
          ? HttpClientRequest.bodyText(baseRequest, requestBody)
          : baseRequest;

        // Execute HTTP request with retry
        const response = yield* client.execute(request).pipe(
          Effect.timeout(timeout),
          Effect.retry({
            times: maxRetries,
            schedule: Schedule.exponential("1 second"),
          }),
          Effect.catchAll((error) => {
            const category = detectHttpErrorCategory(error);
            return Effect.fail(
              new HttpProcessorError(
                `HTTP request failed: ${error instanceof Error ? error.message : String(error)}`,
                category,
                error,
              ),
            );
          }),
        );

        // Parse response body
        const responseText = yield* response.text.pipe(
          Effect.catchAll((error) =>
            Effect.fail(
              new HttpProcessorError(
                `Failed to read HTTP response: ${error instanceof Error ? error.message : String(error)}`,
                "logical",
                error,
              ),
            ),
          ),
        );

        let responseData: unknown;
        try {
          responseData = JSON.parse(responseText);
        } catch {
          // If not JSON, use raw text
          responseData = { raw: responseText };
        }

        yield* Effect.logDebug(
          `HTTP Processor: Received response from ${url} (status: ${response.status})`,
        );

        // Mode 1: Direct mapping (if result_mapping provided)
        if (compiledResultMapping) {
          const mappedContent = yield* Effect.tryPromise({
            try: async () =>
              compiledResultMapping!.evaluate(
                {},
                {
                  http_response: responseData,
                  content: msg.content,
                  meta: msg.metadata,
                  message: {
                    id: msg.id,
                    timestamp: msg.timestamp,
                    correlationId: msg.correlationId,
                  },
                },
              ),
            catch: (error) =>
              new HttpProcessorError(
                `Failed to map HTTP response: ${error instanceof Error ? error.message : String(error)}`,
                "logical",
                error,
              ),
          });

          return {
            ...msg,
            content: mappedContent,
            metadata: {
              ...msg.metadata,
              httpProcessorApplied: true,
            },
          };
        }

        // Mode 2: Store in metadata (default)
        return {
          ...msg,
          metadata: {
            ...msg.metadata,
            [resultKey]: responseData,
            httpProcessorApplied: true,
          },
        };
      });
    },
  };
};
