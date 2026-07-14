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

export const closeRedisClient = async (
  client: RedisClient,
): Promise<void> => {
  if (client.status === "ready") {
    await client.quit();
  } else {
    client.disconnect();
  }
};
