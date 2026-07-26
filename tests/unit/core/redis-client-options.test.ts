import { describe, expect, it, vi } from "vitest";

interface MockRedisInstance {
  options: {
    host: string;
    port: number;
    password?: string;
    db?: number;
    connectTimeout?: number;
    commandTimeout?: number;
    keepAlive?: number;
    lazyConnect?: boolean;
    maxRetriesPerRequest?: number;
    enableOfflineQueue?: boolean;
    retryStrategy: (times: number) => number;
  };
  status: string;
  on: ReturnType<typeof vi.fn>;
  quit: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

vi.mock("ioredis", () => {
  return {
    default: vi.fn(function MockRedis(
      this: MockRedisInstance,
      options: MockRedisInstance["options"],
    ) {
      this.options = options;
      this.status = "wait";
      this.on = vi.fn();
      this.quit = vi.fn(async () => "OK");
      this.disconnect = vi.fn();
      return this;
    }),
  };
});

import Redis from "ioredis";
import {
  createConfiguredRedisClient,
  formatRedisConnectionInfo,
  openConfiguredRedisClient,
} from "../../../src/core/redis-client-options.js";

describe("redis-client-options", () => {
  it("applies shared connection defaults", () => {
    const client = createConfiguredRedisClient({
      host: "redis.local",
      port: 6380,
    }) as unknown as MockRedisInstance;

    expect(Redis).toHaveBeenCalled();
    expect(client.options).toMatchObject({
      host: "redis.local",
      port: 6380,
      db: 0,
      connectTimeout: 10000,
      keepAlive: 30000,
      lazyConnect: false,
      maxRetriesPerRequest: 20,
      enableOfflineQueue: true,
    });
    expect(client.options.retryStrategy(1)).toBe(50);
    expect(client.options.retryStrategy(100)).toBe(2000);
  });

  it("forwards explicit connection overrides", () => {
    const client = createConfiguredRedisClient({
      host: "h",
      port: 1,
      password: "secret",
      db: 3,
      connectTimeout: 1,
      commandTimeout: 2,
      keepAlive: 3,
      lazyConnect: true,
      maxRetriesPerRequest: 4,
      enableOfflineQueue: false,
    }) as unknown as MockRedisInstance;

    expect(client.options).toMatchObject({
      password: "secret",
      db: 3,
      connectTimeout: 1,
      commandTimeout: 2,
      keepAlive: 3,
      lazyConnect: true,
      maxRetriesPerRequest: 4,
      enableOfflineQueue: false,
    });
  });

  it("attaches the error observer when opening a client", () => {
    const client = openConfiguredRedisClient(
      { host: "localhost", port: 6379 },
      "unit test",
    ) as unknown as MockRedisInstance;
    expect(client.on).toHaveBeenCalledWith("error", expect.any(Function));
  });

  it("formats connection info with db defaulting to 0", () => {
    expect(formatRedisConnectionInfo({ host: "localhost", port: 6379 })).toBe(
      "redis://localhost:6379/0",
    );
    expect(
      formatRedisConnectionInfo({ host: "localhost", port: 6379, db: 2 }),
    ).toBe("redis://localhost:6379/2");
  });
});
