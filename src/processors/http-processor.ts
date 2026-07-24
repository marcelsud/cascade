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

type MessageContext = {
  readonly content: unknown;
  readonly meta: Record<string, unknown>;
  readonly message: {
    readonly id: string;
    readonly timestamp: number;
    readonly correlationId?: string;
  };
};

type TaggedHttpError = {
  readonly _tag: string;
  readonly reason?: string;
  readonly response?: { readonly status?: number };
  readonly status?: number;
  readonly message?: unknown;
};

/**
 * Build the exact JSONata evaluation context for one message.
 * Returned object is immutable per evaluation — no shared .assign() state.
 */
const buildMessageContext = (msg: Message): MessageContext => ({
  content: msg.content,
  meta: msg.metadata,
  message: {
    id: msg.id,
    timestamp: msg.timestamp,
    correlationId: msg.correlationId,
  },
});

/**
 * Evaluate JSONata template with message context
 * Templates use {{ }} syntax: "https://api.com/users/{{ content.userId }}"
 */
const evaluateTemplate = (
  template: string,
  context: MessageContext,
): Effect.Effect<string, HttpProcessorError> =>
  Effect.gen(function* () {
    const evaluatedTemplate = yield* Effect.tryPromise({
      try: async () => {
        let result = template;
        const regex = /\{\{(.+?)\}\}/g;
        const matches = [...template.matchAll(regex)];

        for (const match of matches) {
          const expr = match[1].trim();
          const expression = jsonata(expr);
          const value = await expression.evaluate(context, context);
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
 * Evaluate header values that may contain {{ }} templates.
 */
const evaluateHeaders = (
  headers: Record<string, string>,
  context: MessageContext,
): Effect.Effect<Record<string, string>, HttpProcessorError> =>
  Effect.gen(function* () {
    const evaluated: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      evaluated[key] = yield* evaluateTemplate(value, context);
    }
    return evaluated;
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

const classifyStatus = (status: number): ErrorCategory | undefined => {
  if (status >= 500 || status === 429) return "intermittent";
  if (status >= 400) return "logical";
  return undefined;
};

/**
 * Detect error category from HTTP / Effect errors.
 * Recognizes Effect platform ResponseError with reason "StatusCode".
 */
const detectHttpErrorCategory = (error: unknown): ErrorCategory => {
  if (error && typeof error === "object" && "_tag" in error) {
    const tagged = error as TaggedHttpError;
    const tag = tagged._tag;

    // Network/transport errors - retry
    if (tag === "RequestError" || tag === "Transport") {
      return "intermittent";
    }

    // Effect timeout
    if (tag === "TimeoutException") {
      return "intermittent";
    }

    // Effect platform ResponseError: { _tag: "ResponseError", reason: "StatusCode", response.status }
    if (tag === "ResponseError") {
      if (tagged.reason === "StatusCode") {
        const status = tagged.response?.status;
        if (typeof status === "number") {
          const category = classifyStatus(status);
          if (category) return category;
        }
      }
      // Decode / EmptyBody are logical
      return "logical";
    }

    // Legacy / direct status shapes
    if (tag === "StatusCode") {
      const status = tagged.status;
      if (typeof status === "number") {
        const category = classifyStatus(status);
        if (category) return category;
      }
    }
  }

  // Use default detection
  return detectCategory(error);
};

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as TaggedHttpError).message;
    if (typeof message === "string") return message;
  }
  return String(error);
};

const toHttpProcessorError = (error: unknown): HttpProcessorError => {
  if (error instanceof HttpProcessorError) {
    return error;
  }
  return new HttpProcessorError(
    `HTTP request failed: ${errorMessage(error)}`,
    detectHttpErrorCategory(error),
    error,
  );
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

  // Build static auth headers (custom headers may be templated per message)
  const authHeaders = buildAuthHeaders(config.auth);
  const customHeaders = config.headers ?? {};

  // Compile result mapping if provided
  let compiledResultMapping: jsonata.Expression | undefined;
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
        const context = buildMessageContext(msg);

        // Evaluate URL template
        const url = yield* evaluateTemplate(config.url, context);

        yield* Effect.logDebug(`HTTP Processor: ${method} ${url}`);

        // Evaluate request body if provided
        let requestBody: string | undefined;
        if (
          config.body &&
          (method === "POST" || method === "PUT" || method === "PATCH")
        ) {
          requestBody = yield* evaluateTemplate(config.body, context);
        }

        // Evaluate custom header templates
        const evaluatedCustomHeaders = yield* evaluateHeaders(
          customHeaders,
          context,
        );
        const requestHeaders = {
          ...authHeaders,
          ...evaluatedCustomHeaders,
        };

        // Build HTTP client with 2xx filter inside the retried attempt
        const rawClient = yield* HttpClient.HttpClient.pipe(
          Effect.provide(NodeHttpClient.layer),
        );
        const client = HttpClient.filterStatusOk(rawClient);

        const baseRequest = HttpClientRequest.make(method)(url).pipe(
          HttpClientRequest.setHeaders(requestHeaders),
        );

        // Add body if present
        const request = requestBody
          ? HttpClientRequest.bodyText(baseRequest, requestBody)
          : baseRequest;

        // Execute HTTP request with classified retry
        const response = yield* client.execute(request).pipe(
          Effect.timeout(timeout),
          Effect.mapError(toHttpProcessorError),
          Effect.retry({
            times: maxRetries,
            schedule: Schedule.exponential("1 second"),
            while: (error) => error.shouldRetry,
          }),
        );

        // Parse response body
        const responseText = yield* response.text.pipe(
          Effect.mapError(
            (error) =>
              new HttpProcessorError(
                `Failed to read HTTP response: ${error instanceof Error ? error.message : String(error)}`,
                "logical",
                error,
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
          const mappingContext = {
            ...context,
            http_response: responseData,
          };

          const mappedContent = yield* Effect.tryPromise({
            try: async () => compiledResultMapping!.evaluate(mappingContext, mappingContext),
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
