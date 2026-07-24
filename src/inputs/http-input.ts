/**
 * HTTP Input - Webhook server that receives HTTP POST requests
 */
import { Effect, Stream } from "effect";
import * as Schema from "effect/Schema";
import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Input, Message } from "../core/types.js";
import { createMessage } from "../core/types.js";
import { ComponentError, type ErrorCategory } from "../core/errors.js";
import {
  MetricsAccumulator,
  emitInputMetrics,
  measureDuration,
} from "../core/metrics.js";
import {
  validate,
  NonEmptyString,
  Port,
  PositiveInt,
  TimeoutMs,
} from "../core/validation.js";
import {
  createInputQueue,
  offerInputQueue,
  recordQueueDrop,
  type OverflowPolicy,
} from "./input-queue.js";

export interface HttpInputConfig {
  readonly port: number;
  readonly host?: string;
  readonly path?: string; // Webhook path (default: "/webhook")
  readonly timeout?: number; // Request timeout in milliseconds
  readonly queueSize?: number;
  readonly overflow?: OverflowPolicy;
}

export class HttpInputError extends ComponentError {
  readonly _tag = "HttpInputError";

  constructor(
    message: string,
    readonly category: ErrorCategory,
    cause?: unknown,
  ) {
    super(message, cause);
  }
}

/**
 * Validation schema for HTTP Input configuration
 */
export const HttpInputConfigSchema = Schema.Struct({
  port: Port,
  host: Schema.optional(NonEmptyString),
  path: Schema.optional(NonEmptyString),
  timeout: Schema.optional(TimeoutMs),
  queueSize: Schema.optional(PositiveInt),
  overflow: Schema.optional(Schema.Literal("block", "drop_new", "drop_old")),
});

export const validateHttpInputConfig = (
  config: HttpInputConfig,
): Effect.Effect<void, HttpInputError> =>
  validate(HttpInputConfigSchema, config, "HTTP Input configuration").pipe(
    Effect.mapError(
      (error) => new HttpInputError(error.message, error.category, error),
    ),
    Effect.asVoid,
  );

/**
 * Private error used to distinguish request-body read timeouts from other failures.
 */
class RequestBodyTimeoutError extends Error {
  readonly _tag = "RequestBodyTimeoutError" as const;

  constructor(timeoutMs: number) {
    super(`Request body timed out after ${timeoutMs}ms`);
    this.name = "RequestBodyTimeoutError";
  }
}

const isRequestBodyTimeoutError = (
  error: unknown,
): error is RequestBodyTimeoutError =>
  error instanceof RequestBodyTimeoutError;

/**
 * Read request body as string, enforcing an absolute timeout from the start of reading.
 */
const readBody = (
  request: IncomingMessage,
  timeoutMs: number,
): Promise<string> => {
  let resolve!: (value: string) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const chunks: Buffer[] = [];
  let settled = false;

  const onData = (chunk: Buffer | string) => {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  };

  const cleanup = () => {
    clearTimeout(timer);
    request.removeListener("data", onData);
    request.removeListener("end", onEnd);
    request.removeListener("error", onError);
  };

  const settle = (action: () => void) => {
    if (settled) {
      return;
    }
    settled = true;
    cleanup();
    action();
  };

  const onEnd = () => {
    settle(() => resolve(Buffer.concat(chunks).toString()));
  };

  const onError = (error: Error) => {
    settle(() => reject(error));
  };

  const timer = setTimeout(() => {
    settle(() => reject(new RequestBodyTimeoutError(timeoutMs)));
  }, timeoutMs);

  request.on("data", onData);
  request.on("end", onEnd);
  request.on("error", onError);

  return promise;
};

/**
 * Convert HTTP request to internal Message
 */
const convertHttpRequest = (
  request: IncomingMessage,
  body: string,
): Effect.Effect<Message, HttpInputError> =>
  Effect.gen(function* () {
    // Parse JSON body
    let content: unknown;
    try {
      content = JSON.parse(body);
    } catch (error) {
      yield* Effect.logWarning(
        `Failed to parse request body as JSON, using raw: ${error}`,
      );
      content = { raw: body };
    }

    // Create message with headers as metadata
    const message = createMessage(content, {
      source: "http-input",
      method: request.method || "POST",
      url: request.url || "/",
      headers: request.headers as Record<string, string>,
    });

    return message;
  });

/**
 * Create HTTP Input component (webhook server)
 *
 * @param config - HTTP input configuration
 * @returns Input component that receives HTTP POST requests
 *
 * @example
 * ```typescript
 * const input = createHttpInput({
 *   port: 8080,
 *   host: "0.0.0.0",
 *   path: "/webhook",
 *   timeout: 30000
 * })
 * ```
 */
export const createHttpInput = (
  config: HttpInputConfig,
): Input<HttpInputError> => {
  // Validate configuration synchronously
  Effect.runSync(validateHttpInputConfig(config));

  const host = config.host ?? "0.0.0.0";
  const path = config.path ?? "/webhook";
  const timeout = config.timeout ?? 30_000;
  const queueSize = config.queueSize ?? 1_000;
  const overflow = config.overflow ?? "block";

  // Setup metrics
  const metrics = new MetricsAccumulator("http-input");

  // Create message queue for incoming requests
  const messageQueue = Effect.runSync(
    createInputQueue<Message>(queueSize, overflow),
  );
  const dropLogState = { lastLogAt: 0, suppressed: 0 };

  // Create HTTP server
  let server: Server | null = null;

  const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      // Only accept POST requests on the specified path
      if (req.method !== "POST" || req.url !== path) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
        return;
      }

      // Read request body with configured absolute timeout
      const body = await readBody(req, timeout);

      // Convert to message and measure duration
      const result = await Effect.runPromise(
        measureDuration(convertHttpRequest(req, body)),
      );

      const [message, duration] = result;

      // Add to queue
      const offer = await Effect.runPromise(
        offerInputQueue(messageQueue, message, overflow, queueSize),
      );
      if (offer.dropped > 0) {
        await Effect.runPromise(recordQueueDrop(metrics, dropLogState, "HTTP"));
      }

      if (offer.accepted) {
        metrics.recordProcessed(duration);

        // Emit metrics every 100 accepted messages
        const metricsSnapshot = metrics.getInputMetrics();
        if (metricsSnapshot.messagesProcessed % 100 === 0) {
          await Effect.runPromise(emitInputMetrics(metricsSnapshot));
        }
      }

      // Return 200 OK
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("OK");
    } catch (error) {
      metrics.recordError();

      const canWrite = !res.headersSent && !res.writableEnded && !res.destroyed;
      if (isRequestBodyTimeoutError(error)) {
        if (canWrite) {
          res.writeHead(408, {
            "Content-Type": "text/plain",
            Connection: "close",
          });
          res.end("Request Timeout", () => {
            // Ensure the request/socket is terminated after the response flushes.
            if (!req.destroyed) {
              req.destroy();
            }
          });
        } else if (!req.destroyed) {
          req.destroy();
        }
      } else if (canWrite) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal Server Error");
      }

      await Effect.runPromise(
        Effect.logError(`HTTP Input error: ${error}`),
      ).catch(() => undefined);
    }
  };

  // Start server
  server = createServer(handleRequest);
  server.listen(config.port, host);

  Effect.runSync(
    Effect.log(`HTTP Input listening on ${host}:${config.port}${path}`),
  );

  // Create stream from queue
  const stream = Stream.fromQueue(messageQueue);

  return {
    name: "http-input",
    getMetrics: () => metrics.getInputMetrics(),
    stream,

    close: (): Effect.Effect<void, never> =>
      Effect.gen(function* () {
        yield* Effect.log("HTTP Input closing");

        // Close server
        if (server) {
          yield* Effect.async<void>((resume) => {
            server!.close((error) => {
              if (error) {
                resume(
                  Effect.logError(`Failed to close HTTP server: ${error}`),
                );
              } else {
                resume(Effect.succeed(undefined));
              }
            });
          });
        }

        yield* emitInputMetrics(metrics.getInputMetrics());
      }),
  };
};
