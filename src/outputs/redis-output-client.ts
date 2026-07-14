import { Effect } from "effect";

export interface RedisOutputClient {
  readonly status: string;
  on?(event: "error", listener: (error: Error) => void): unknown;
  quit(): Promise<unknown>;
  disconnect(): void;
}

export const observeRedisOutputErrors = (
  client: RedisOutputClient,
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

export const closeRedisOutputClient = async (
  client: RedisOutputClient,
): Promise<void> => {
  if (client.status === "ready") {
    await client.quit();
  } else {
    client.disconnect();
  }
};
