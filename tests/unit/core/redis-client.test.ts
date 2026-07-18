import { describe, expect, it, vi } from "vitest";
import {
  closeRedisClient,
  observeRedisClientErrors,
  type RedisClient,
} from "../../../src/core/redis-client.js";

const makeClient = (status: string) => {
  let errorListener: ((error: Error) => void) | undefined;
  const client: RedisClient = {
    status,
    on: vi.fn((_event, listener) => {
      errorListener = listener;
      return client;
    }),
    quit: vi.fn(async () => "OK"),
    disconnect: vi.fn(),
  };
  return { client, getErrorListener: () => errorListener };
};

describe("Redis client lifecycle", () => {
  it("observes client errors without throwing from the event handler", () => {
    const { client, getErrorListener } = makeClient("wait");
    observeRedisClientErrors(client, "test component");

    expect(() => getErrorListener()?.(new Error("offline"))).not.toThrow();
    expect(client.on).toHaveBeenCalledWith("error", expect.any(Function));
  });

  it("disconnects a never-connected client without waiting for quit", async () => {
    const { client } = makeClient("wait");

    await expect(closeRedisClient(client)).resolves.toBeUndefined();
    expect(client.disconnect).toHaveBeenCalledOnce();
    expect(client.quit).not.toHaveBeenCalled();
  });

  it("quits a ready client cleanly", async () => {
    const { client } = makeClient("ready");

    await expect(closeRedisClient(client)).resolves.toBeUndefined();
    expect(client.quit).toHaveBeenCalledOnce();
    expect(client.disconnect).not.toHaveBeenCalled();
  });
});
