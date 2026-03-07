/**
 * JavaScript Processor - Sandboxed JS execution via QuickJS (WASM)
 */
import { Effect } from "effect";
import { getQuickJS } from "quickjs-emscripten";
import type { Processor, Message } from "../core/types.js";

export interface JavaScriptProcessorConfig {
  readonly code: string;
  readonly timeout_ms?: number;
  readonly memory_limit_bytes?: number;
}

export class JavaScriptProcessorError {
  readonly _tag = "JavaScriptProcessorError";
  constructor(
    readonly message: string,
    readonly cause?: unknown,
  ) {}
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MEMORY_LIMIT = 128 * 1024 * 1024; // 128MB

/**
 * Create a JavaScript processor using QuickJS WASM sandbox
 * No access to fs, net, process, require — fully isolated
 */
export const createJavaScriptProcessor = (
  config: JavaScriptProcessorConfig,
): Processor<JavaScriptProcessorError> => {
  const timeoutMs = config.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const memoryLimit = config.memory_limit_bytes ?? DEFAULT_MEMORY_LIMIT;

  // Wrap user code in a function that receives context and returns result
  const wrappedCode = `
(function() {
  const __input = JSON.parse(__inputJson);
  const content = __input.content;
  const metadata = __input.metadata;
  const message = __input.message;
  ${config.code}
})()
`;

  return {
    name: "javascript-processor",
    process: (msg: Message): Effect.Effect<Message | Message[], JavaScriptProcessorError> => {
      return Effect.tryPromise({
        try: async () => {
          const QuickJS = await getQuickJS();
          const runtime = QuickJS.newRuntime();

          runtime.setMemoryLimit(memoryLimit);
          runtime.setInterruptHandler(() => {
            return shouldInterrupt();
          });

          // Timeout via interrupt handler
          const startTime = Date.now();
          const shouldInterrupt = () => Date.now() - startTime > timeoutMs;

          const ctx = runtime.newContext();

          try {
            // Inject input data as JSON string
            const inputData = {
              content: msg.content,
              metadata: msg.metadata,
              message: {
                id: msg.id,
                timestamp: msg.timestamp,
                correlationId: msg.correlationId,
              },
            };

            const inputHandle = ctx.newString(JSON.stringify(inputData));
            ctx.setProp(ctx.global, "__inputJson", inputHandle);
            inputHandle.dispose();

            // Evaluate
            const result = ctx.evalCode(wrappedCode);

            if (result.error) {
              const errorMsg = ctx.dump(result.error);
              result.error.dispose();
              throw new Error(
                typeof errorMsg === "object" && errorMsg !== null
                  ? (errorMsg as any).message || JSON.stringify(errorMsg)
                  : String(errorMsg),
              );
            }

            const value = ctx.dump(result.value);
            result.value.dispose();

            // Support returning array of contents (fan-out)
            if (Array.isArray(value)) {
              return value.map((item, i) => ({
                ...msg,
                content: item,
                metadata: {
                  ...msg.metadata,
                  javascriptProcessed: true,
                  fanOutIndex: i,
                },
              }));
            }

            return {
              ...msg,
              content: value,
              metadata: {
                ...msg.metadata,
                javascriptProcessed: true,
              },
            };
          } finally {
            ctx.dispose();
            runtime.dispose();
          }
        },
        catch: (error) =>
          new JavaScriptProcessorError(
            `JavaScript execution failed: ${error instanceof Error ? error.message : String(error)}`,
            error,
          ),
      });
    },
  };
};
