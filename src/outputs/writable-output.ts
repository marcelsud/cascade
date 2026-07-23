/**
 * Shared writable-output internals — used by stdout and file outputs.
 *
 * Two independent pieces:
 *  - `serializeMessage`: turns a Message into a single-record string using the
 *    `content`/`message` formats (no trailing delimiter — the coordinator adds
 *    it). This is the seam a future CSV codec plugs into: supply record strings
 *    to the same coordinator; no coordinator changes needed.
 *  - `createWriteCoordinator`: owns write ordering, backpressure, the
 *    dual write-callback + 'error'-event settle dance, and close/lifecycle
 *    semantics for both borrowed (stdout) and owned (file) streams. It is
 *    category-agnostic: it rejects with a {@link StreamWriteError} carrying the
 *    failing phase, and each output maps that phase to its own ErrorCategory.
 */
import type { Writable } from "node:stream";
import type { Message } from "../core/types.js";

/**
 * JSON.stringify silently *omits* an object key whose value is undefined, a
 * function, or a symbol — including when an object's toJSON() returns one of
 * those values. For root content that would either remove "content" from a
 * `message` envelope or write "undefined" in `content` format. Reject those
 * cases while preserving normal JSON semantics for nested fields.
 */
const isRootUnrepresentable = (value: unknown): boolean =>
  value === undefined ||
  typeof value === "function" ||
  typeof value === "symbol";

/**
 * Serialize a message into a single record line (without a trailing newline).
 *
 * Throws if content can't be turned into a line: the checks above catch
 * root-level undefined/function/symbol, and JSON.stringify itself throws on
 * circular references or BigInt (at any depth).
 */
export const serializeMessage = (
  msg: Message,
  format: "content" | "message",
): string => {
  if (format === "message") {
    const envelope = {
      id: msg.id,
      correlationId: msg.correlationId,
      timestamp: msg.timestamp,
      content: msg.content,
      metadata: msg.metadata,
      trace: msg.trace,
    };
    const line = JSON.stringify(envelope, function (key, value) {
      if (
        this === envelope &&
        key === "content" &&
        isRootUnrepresentable(value)
      ) {
        throw new Error(
          `Message content of type "${typeof value}" cannot be represented in the output envelope`,
        );
      }
      return value;
    });
    if (line === undefined) {
      throw new Error("Message envelope is not JSON-serializable");
    }
    return line;
  }

  // format === "content": strings are written raw (not JSON-encoded),
  // everything else is JSON-serialized.
  if (typeof msg.content === "string") {
    return msg.content;
  }
  const line = JSON.stringify(msg.content);
  if (line === undefined) {
    throw new Error(
      `Message content of type "${typeof msg.content}" is not JSON-serializable`,
    );
  }
  return line;
};

/** Which stage of the stream lifecycle a coordinator failure came from. */
export type WritePhase = "open" | "write" | "close";

/**
 * Raw failure surfaced by the coordinator. Carries the lifecycle `phase` so the
 * owning output can pick the right ErrorCategory (e.g. open → fatal, write →
 * intermittent) without the coordinator knowing anything about categories.
 */
export class StreamWriteError extends Error {
  readonly _tag = "StreamWriteError";

  constructor(
    readonly phase: WritePhase,
    readonly cause?: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "StreamWriteError";
  }
}

export interface WriteCoordinator {
  /** Write one record (a newline is appended). Resolves once it has flushed. */
  readonly write: (line: string) => Promise<void>;
  /** Drain in-flight writes and release the stream per its ownership. */
  readonly close: () => Promise<void>;
}

/** Borrowed stream (e.g. process.stdout): never opened, never ended by us. */
export interface BorrowedStreamOptions {
  readonly stream: Writable;
}

/**
 * Owned stream (e.g. a file): created lazily on the first write so that
 * validation, construction, and zero-message runs never touch the filesystem.
 * Closed (ended) when the coordinator closes.
 */
export interface OwnedStreamOptions {
  readonly open: () => Writable;
  readonly owned: true;
}

const isOwned = (
  options: BorrowedStreamOptions | OwnedStreamOptions,
): options is OwnedStreamOptions => "owned" in options;

/**
 * Create a write coordinator over a borrowed or owned Writable.
 *
 * A real Writable emits BOTH the write() callback and an 'error' event on
 * failure. Without an 'error' listener, Node treats that as an unhandled error
 * and throws (uncaughtException) even though the callback already reports it.
 * `settleCurrentWrite` lets whichever fires first resolve the in-flight write;
 * the other is a no-op via the `settled` guard.
 */
export const createWriteCoordinator = (
  options: BorrowedStreamOptions | OwnedStreamOptions,
): WriteCoordinator => {
  const owned = isOwned(options);

  let stream: Writable | null = null;
  // Borrowed streams are "open" from the start. Owned streams flip this on the
  // 'open' event, which lets us tell an open failure (error before 'open') from
  // a mid-stream write failure (error after 'open').
  let opened = !owned;

  let settleCurrentWrite: ((error?: Error | null) => void) | null = null;
  const onStreamError = (error: Error) => {
    const settle = settleCurrentWrite;
    settleCurrentWrite = null;
    if (settle) {
      settle(error);
    }
    // No write in flight: swallow so a stray/idle stream error never becomes an
    // uncaughtException. The next write() will surface any persistent failure
    // through its own callback/error pairing.
  };
  const onStreamOpen = () => {
    opened = true;
  };

  const detachLifecycleListeners = () => {
    if (!stream) return;
    stream.removeListener("error", onStreamError);
    stream.removeListener("open", onStreamOpen);
  };

  const ensureStream = (): Writable => {
    if (stream) return stream;
    const created = (options as OwnedStreamOptions).open();
    created.on("error", onStreamError);
    created.on("open", onStreamOpen);
    stream = created;
    return created;
  };

  if (!owned) {
    stream = options.stream;
    stream.on("error", onStreamError);
  }

  // Chain onto this promise so concurrent write() calls still hit the stream in
  // call order. It never rejects, so a failed write doesn't stall the queue.
  let writeQueue: Promise<void> = Promise.resolve();

  const write = (line: string): Promise<void> => {
    const result = writeQueue.then(
      () =>
        new Promise<void>((resolve, reject) => {
          let settled = false;
          const settle = (error?: Error | null) => {
            if (settled) return;
            settled = true;
            settleCurrentWrite = null;
            if (error) {
              reject(new StreamWriteError(opened ? "write" : "open", error));
            } else {
              resolve();
            }
          };

          let target: Writable;
          try {
            target = ensureStream();
          } catch (error) {
            // Synchronous open failure (e.g. createWriteStream threw). Before
            // any 'open' event, so classify as an open-phase failure.
            settle(error instanceof Error ? error : new Error(String(error)));
            return;
          }

          settleCurrentWrite = settle;
          target.write(`${line}\n`, (error) => settle(error));
        }),
    );
    writeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const close = async (): Promise<void> => {
    // Wait for any in-flight writes first.
    await writeQueue;

    if (!owned) {
      // Borrowed: only detach our own listener; never end the shared stream.
      if (stream) {
        stream.removeListener("error", onStreamError);
      }
      return;
    }

    // Owned but never opened (zero writes): nothing was created, nothing to
    // flush, and no file was ever touched.
    if (!stream) {
      return;
    }

    const target = stream;
    if (target.destroyed || target.writableEnded) {
      // Already errored/ended (e.g. open failure surfaced via a write); the
      // failure was reported to the caller. Just clean up.
      detachLifecycleListeners();
      return;
    }

    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          target.removeListener("finish", onFinish);
          target.removeListener("error", onCloseError);
        };
        const onFinish = () => {
          cleanup();
          resolve();
        };
        const onCloseError = (error: Error) => {
          cleanup();
          reject(new StreamWriteError("close", error));
        };
        // Swap the write-time error listener for a close-time one so a flush
        // failure surfaces here instead of being swallowed.
        target.removeListener("error", onStreamError);
        target.once("finish", onFinish);
        target.once("error", onCloseError);
        target.end();
      });
    } finally {
      detachLifecycleListeners();
    }
  };

  return { write, close };
};
