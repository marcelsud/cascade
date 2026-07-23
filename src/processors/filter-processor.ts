/**
 * Filter Processor - Suppresses messages that do not satisfy a JSONata check.
 *
 * @experimental This component is alpha. Its configuration shape and
 * expression semantics may change in a backwards-incompatible way before it
 * stabilizes.
 */
import { Effect } from "effect";
import * as Schema from "effect/Schema";
import jsonata from "jsonata";
import type { Message, Processor } from "../core/types.js";
import { ComponentError } from "../core/errors.js";
import { NonEmptyString, validate } from "../core/validation.js";

/**
 * @experimental Config shape may change before this component stabilizes.
 */
export interface FilterProcessorConfig {
  readonly check: string;
}

export class FilterError extends ComponentError {
  readonly _tag = "FilterError";
  readonly category = "logical" as const;
}

export const FilterProcessorConfigSchema = Schema.Struct({
  check: NonEmptyString.pipe(
    Schema.filter((value) => value.trim().length > 0, {
      message: () => "Filter processor check cannot be blank",
    }),
  ),
});

/**
 * Create a Filter processor.
 *
 * @experimental Alpha component — see module docs.
 */
export const createFilterProcessor = (
  config: FilterProcessorConfig,
): Processor<FilterError> => {
  Effect.runSync(
    validate(
      FilterProcessorConfigSchema,
      config,
      "Filter Processor configuration",
    ).pipe(Effect.mapError((error) => new FilterError(error.message, error))),
  );

  let compiledCheck: ReturnType<typeof jsonata>;
  try {
    compiledCheck = jsonata(config.check);
  } catch (error) {
    throw new FilterError(
      `Failed to compile filter check: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }

  return {
    name: "filter-processor",
    process: (msg: Message) =>
      Effect.gen(function* () {
        const context =
          typeof msg.content === "object" && msg.content !== null
            ? msg.content
            : { value: msg.content };

        const result = yield* Effect.tryPromise({
          try: () =>
            compiledCheck.evaluate(context, {
              meta: msg.metadata,
              message: {
                id: msg.id,
                timestamp: msg.timestamp,
                correlationId: msg.correlationId,
              },
            }),
          catch: (error) =>
            new FilterError(
              `Failed to evaluate filter check for message ${msg.id}: ${error instanceof Error ? error.message : String(error)}`,
              error,
            ),
        });

        const accepted = Boolean(result);
        yield* Effect.logDebug(
          `Filter ${accepted ? "accepted" : "dropped"} message`,
          {
            component: "filter-processor",
            messageId: msg.id,
          },
        );

        return accepted ? msg : [];
      }),
  };
};
