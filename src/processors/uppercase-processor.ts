/**
 * Uppercase Processor - Transforms specified fields to uppercase
 */
import { Effect } from "effect";
import type { Processor, Message } from "../core/types.js";

export interface UppercaseProcessorConfig {
  readonly fields: readonly string[];
}

/**
 * Helper to transform nested object paths
 */
const setNestedValue = (obj: any, path: string, value: any): any => {
  const keys = path.split(".");
  const result = { ...obj };
  let current = result;

  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    current[key] = { ...current[key] };
    current = current[key];
  }

  const lastKey = keys.at(-1);
  if (lastKey !== undefined) {
    current[lastKey] = value;
  }
  return result;
};

const getNestedValue = (obj: any, path: string): any => {
  return path.split(".").reduce((acc, key) => acc?.[key], obj);
};

/**
 * Create an uppercase processor
 * Transforms specified fields to uppercase
 */
export const createUppercaseProcessor = (
  config: UppercaseProcessorConfig,
): Processor => {
  return {
    name: "uppercase-processor",
    process: (msg: Message): Effect.Effect<Message> => {
      return Effect.sync(() => {
        let transformedContent = msg.content;

        // Transform each specified field
        for (const field of config.fields) {
          const value = getNestedValue(transformedContent, field);

          if (typeof value === "string") {
            transformedContent = setNestedValue(
              transformedContent,
              field,
              value.toUpperCase(),
            );
          }
        }

        return {
          ...msg,
          content: transformedContent,
          metadata: {
            ...msg.metadata,
            uppercasedFields: config.fields,
          },
        };
      });
    },
  };
};
