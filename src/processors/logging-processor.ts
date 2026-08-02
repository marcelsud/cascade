/**
 * Logging Processor - Logs messages passing through the pipeline
 */
import { Effect } from "effect";
import type { Processor, Message } from "../core/types.js";

export interface LoggingProcessorConfig {
  readonly level?: "debug" | "info" | "warn" | "error";
  readonly includeContent?: boolean;
}

type LoggingLevel = NonNullable<LoggingProcessorConfig["level"]>;

const logAtLevel = (
  level: LoggingLevel,
  message: string,
): Effect.Effect<void> => {
  switch (level) {
    case "debug":
      return Effect.logDebug(message);
    case "warn":
      return Effect.logWarning(message);
    case "error":
      return Effect.logError(message);
    case "info":
      return Effect.log(message);
  }
};

/**
 * Create a logging processor
 * Logs messages with structured information
 */
export const createLoggingProcessor = (
  config: LoggingProcessorConfig = {},
): Processor => {
  const level = config.level || "info";
  const includeContent = config.includeContent ?? true;

  return {
    name: "logging-processor",
    process: (msg: Message): Effect.Effect<Message> => {
      const logData = {
        messageId: msg.id,
        correlationId: msg.correlationId,
        timestamp: msg.timestamp,
        metadata: msg.metadata,
        ...(includeContent ? { content: msg.content } : {}),
      };

      const logMessage = `Processing message: ${JSON.stringify(logData, null, 2)}`;

      // Choose appropriate log level
      const logEffect = logAtLevel(level, logMessage);

      return Effect.gen(function* () {
        yield* logEffect;
        return msg;
      });
    },
  };
};
