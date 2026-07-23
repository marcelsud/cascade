/**
 * Switch Processor - Conditional routing based on message content
 *
 * The switch processor evaluates JSONata expressions against the message
 * and executes the first matching case's nested processors.
 * Similar to switch/case in programming languages.
 *
 * Example use case: Route orders to different processors based on order type
 */
import { Effect } from "effect";
import jsonata from "jsonata";
import type { Processor, Message } from "../core/types.js";
import { runProcessorChain } from "../core/processor-chain.js";

export interface SwitchCase {
  readonly check: string; // JSONata boolean expression
  readonly processors: readonly Processor<any, any>[];
}

export interface SwitchProcessorConfig {
  readonly cases: readonly SwitchCase[];
}

export class SwitchError {
  readonly _tag = "SwitchError";
  constructor(
    readonly message: string,
    readonly cause?: unknown,
  ) {}
}

/**
 * Create a switch processor
 * Evaluates cases in order and executes the first matching case's processors
 */
export const createSwitchProcessor = (
  config: SwitchProcessorConfig,
): Processor<SwitchError, any> => {
  // Pre-compile all JSONata check expressions
  const compiledCases = config.cases.map((switchCase) => {
    try {
      return {
        check: jsonata(switchCase.check),
        processors: switchCase.processors,
      };
    } catch (error) {
      throw new Error(
        `Failed to compile switch check expression "${switchCase.check}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  });

  return {
    name: "switch-processor",
    process: (
      msg: Message,
    ): Effect.Effect<Message | Message[], SwitchError, any> => {
      return Effect.gen(function* () {
        // Prepare context for JSONata evaluation
        const context =
          typeof msg.content === "object" && msg.content !== null
            ? msg.content
            : { value: msg.content };

        // Find the first matching case
        for (const compiledCase of compiledCases) {
          // Bind special variables
          compiledCase.check.assign("message", {
            id: msg.id,
            timestamp: msg.timestamp,
            correlationId: msg.correlationId,
          });
          compiledCase.check.assign("meta", msg.metadata);

          // Evaluate the check expression
          const matches = yield* Effect.tryPromise({
            try: async () => {
              const result = await compiledCase.check.evaluate(context);
              // Coerce to boolean
              return Boolean(result);
            },
            catch: (error) =>
              new SwitchError(
                `Failed to evaluate switch check: ${
                  error instanceof Error ? error.message : String(error)
                }`,
                error,
              ),
          });

          // If this case matches, execute its processors
          if (matches) {
            const results = yield* runProcessorChain(
              msg,
              compiledCase.processors,
            );
            return results.length === 1 ? results[0] : results;
          }
        }

        // No case matched - return message unchanged
        return msg;
      });
    },
  };
};
