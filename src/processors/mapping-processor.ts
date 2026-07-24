/**
 * Mapping Processor - JSONata-based transformations
 */
import { Effect } from "effect";
import jsonata from "jsonata";
import type { Processor, Message } from "../core/types.js";

export interface MappingProcessorConfig {
  readonly expression: string;
}

export class MappingError {
  readonly _tag = "MappingError";
  constructor(
    readonly message: string,
    readonly cause?: unknown,
  ) {}
}

/**
 * Create a mapping processor using JSONata
 * Enables declarative data transformations similar to Bloblang
 */
export const createMappingProcessor = (
  config: MappingProcessorConfig,
): Processor<MappingError> => {
  // Compile JSONata expression once during processor creation
  let compiledExpression: ReturnType<typeof jsonata>;

  try {
    compiledExpression = jsonata(config.expression);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to compile JSONata expression: ${errorMessage}`);
  }

  return {
    name: "mapping-processor",
    process: (msg: Message): Effect.Effect<Message, MappingError> => {
      return Effect.gen(function* () {
        // Prepare context for JSONata evaluation
        const context =
          typeof msg.content === "object" && msg.content !== null
            ? msg.content
            : { value: msg.content };

        // Evaluate with call-local bindings (concurrency-safe)
        const result = yield* Effect.tryPromise({
          try: async () =>
            compiledExpression.evaluate(context, {
              message: {
                id: msg.id,
                timestamp: msg.timestamp,
                correlationId: msg.correlationId,
              },
              meta: msg.metadata,
            }),
          catch: (error) =>
            new MappingError(
              `JSONata evaluation failed: ${error instanceof Error ? error.message : String(error)}`,
              error,
            ),
        });

        // Return transformed message
        return {
          ...msg,
          content: result,
          metadata: {
            ...msg.metadata,
            mappingApplied: true,
            mappingExpression: config.expression.slice(0, 100), // First 100 chars for tracking
          },
        };
      });
    },
  };
};
