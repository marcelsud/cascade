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

/**
 * Read request body as string
 */
const readBody = (request: IncomingMessage): Promise<string> => {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString()));
    request.on("error", reject);
  });
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
  Effect.runSync(
    validate(HttpInputConfigSchema, config, "HTTP Input configuration").pipe(
      Effect.catchAll((error) => Effect.die(error)),
    ),
  );

  const host = config.host ?? "0.0.0.0";
  const path = config.path ?? "/webhook";
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

      // Read request body
      const body = await readBody(req);

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
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal Server Error");
      Effect.runSync(Effect.logError(`HTTP Input error: ${error}`));
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
