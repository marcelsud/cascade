import { describe, expect, it, vi } from "vitest";
import {
  closeRedisOutputClient,
  observeRedisOutputErrors,
  type RedisOutputClient,
} from "../../../src/outputs/redis-output-client.js";

const makeClient = (status: string) => {
  let errorListener: ((error: Error) => void) | undefined;
  const client: RedisOutputClient = {
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

describe("Redis output client lifecycle", () => {
  it("observes client errors without throwing from the event handler", () => {
    const { client, getErrorListener } = makeClient("wait");
    observeRedisOutputErrors(client, "test output");

    expect(() => getErrorListener()?.(new Error("offline"))).not.toThrow();
    expect(client.on).toHaveBeenCalledWith("error", expect.any(Function));
  });

  it("disconnects a never-connected client without waiting for quit", async () => {
    const { client } = makeClient("wait");

    await expect(closeRedisOutputClient(client)).resolves.toBeUndefined();
    expect(client.disconnect).toHaveBeenCalledOnce();
    expect(client.quit).not.toHaveBeenCalled();
  });

  it("quits a ready client cleanly", async () => {
    const { client } = makeClient("ready");

    await expect(closeRedisOutputClient(client)).resolves.toBeUndefined();
    expect(client.quit).toHaveBeenCalledOnce();
    expect(client.disconnect).not.toHaveBeenCalled();
  });
});
