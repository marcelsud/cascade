import { Effect } from "effect";

export interface RedisClient {
  readonly status: string;
  on?(event: "error", listener: (error: Error) => void): unknown;
  quit(): Promise<unknown>;
  disconnect(): void;
}

export const observeRedisClientErrors = (
  client: RedisClient,
  component: string,
): void => {
  client.on?.("error", (error) => {
    Effect.runFork(
      Effect.logDebug(
        `${component} Redis client error: ${error.message || String(error)}`,
      ),
    );
  });
};

const REDIS_QUIT_TIMEOUT_MS = 1_000;

export const closeRedisClient = async (client: RedisClient): Promise<void> => {
  if (client.status !== "ready") {
    client.disconnect();
    return;
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      client.quit(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error(
                `Redis client QUIT timed out after ${REDIS_QUIT_TIMEOUT_MS}ms`,
              ),
            ),
          REDIS_QUIT_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (error) {
    // A rejected or stalled QUIT must not leave a manually-closing socket open.
    client.disconnect();
    throw error;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
};
