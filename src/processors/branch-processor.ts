/**
 * Branch Processor - Runs nested processors while preserving original message
 *
 * The branch processor executes a nested pipeline on a copy of the message,
 * then merges the result back into the original message's metadata.
 * This is useful for API enrichment patterns where you want to preserve
 * the original message content while adding enrichment data.
 *
 * Example use case: Enrich user data from external API without modifying original message
 */
import { Effect } from "effect";
import type { Processor, Message } from "../core/types.js";
import { runProcessorChain } from "../core/processor-chain.js";

export interface BranchProcessorConfig {
  readonly processors: readonly Processor<any, any>[];
}

/**
 * Create a branch processor
 * Executes nested processors on a copy of the message, merges result into metadata
 */
export const createBranchProcessor = (
  config: BranchProcessorConfig,
): Processor<any, any> => {
  return {
    name: "branch-processor",
    process: (
      originalMessage: Message,
    ): Effect.Effect<Message | Message[], any, any> => {
      return Effect.gen(function* () {
        // Create a copy of the message for branch processing
        // Use JSON parse/stringify for deep clone to ensure compatibility
        const branchMessage: Message = {
          ...originalMessage,
          metadata: { ...originalMessage.metadata },
          content: JSON.parse(JSON.stringify(originalMessage.content)),
        };

        const branchResults = yield* runProcessorChain(
          branchMessage,
          config.processors,
        );

        // Preserve the original once per branch result. Empty branch results
        // suppress the original, matching normal processor-chain cardinality.
        const results = branchResults.map((processedBranchMessage) => ({
          ...originalMessage,
          metadata: {
            ...originalMessage.metadata,
            branchResult: {
              content: processedBranchMessage.content,
              metadata: processedBranchMessage.metadata,
            },
          },
        }));

        return results.length === 1 ? results[0] : results;
      });
    },
  };
};
