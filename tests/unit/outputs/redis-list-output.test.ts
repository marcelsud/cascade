import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Effect } from "effect";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as yaml from "yaml";
import Redis from "ioredis";
import { loadConfig } from "../../../src/core/config-loader.js";
import { buildPipeline } from "../../../src/core/pipeline-builder.js";
import { createRedisListOutput } from "../../../src/outputs/redis-list-output.js";
import type { Message } from "../../../src/core/types.js";

type ListStore = Map<string, string[]>;

interface MockRedisClient {
  status: string;
  lpush: ReturnType<typeof vi.fn>;
  rpush: ReturnType<typeof vi.fn>;
  ltrim: ReturnType<typeof vi.fn>;
  lrange: ReturnType<typeof vi.fn>;
  quit: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
}

const stores: ListStore[] = [];

// In-memory ioredis mock with LPUSH/RPUSH/LTRIM semantics (incl. negative indices)
vi.mock("ioredis", () => {
  return {
    default: vi.fn(() => {
      const lists: ListStore = new Map();
      stores.push(lists);

      const getList = (key: string): string[] => {
        let list = lists.get(key);
        if (!list) {
          list = [];
          lists.set(key, list);
        }
        return list;
      };

      const resolveIndex = (index: number, length: number): number => {
        if (index < 0) {
          return Math.max(0, length + index);
        }
        return Math.min(index, Math.max(0, length - 1));
      };

      const client: MockRedisClient = {
        status: "ready",
        lpush: vi.fn(async (key: string, ...values: string[]) => {
          const list = getList(key);
          // Redis LPUSH inserts values one-by-one at head; multi-value order
          // ends with the last argument at index 0.
          for (const value of values) {
            list.unshift(value);
          }
          return list.length;
        }),
        rpush: vi.fn(async (key: string, ...values: string[]) => {
          const list = getList(key);
          list.push(...values);
          return list.length;
        }),
        ltrim: vi.fn(async (key: string, start: number, stop: number) => {
          const list = getList(key);
          if (list.length === 0) {
            return "OK";
          }
          const from = resolveIndex(start, list.length);
          const to = resolveIndex(stop, list.length);
          if (from > to) {
            lists.set(key, []);
            return "OK";
          }
          lists.set(key, list.slice(from, to + 1));
          return "OK";
        }),
        lrange: vi.fn(async (key: string, start: number, stop: number) => {
          const list = getList(key);
          if (list.length === 0) {
            return [];
          }
          const from = resolveIndex(start, list.length);
          const to = resolveIndex(stop, list.length);
          if (from > to) {
            return [];
          }
          return list.slice(from, to + 1);
        }),
        quit: vi.fn().mockResolvedValue("OK"),
        disconnect: vi.fn(),
        on: vi.fn(),
      };

      return client;
    }),
  };
});

const createMessage = (id: string, content: unknown = { id }): Message => ({
  id,
  content,
  metadata: {},
  timestamp: Date.now(),
  correlationId: `corr-${id}`,
});

const listIds = (store: ListStore, key: string): string[] => {
  const entries = store.get(key) ?? [];
  return entries.map((payload) => {
    const parsed: unknown = JSON.parse(payload);
    if (
      parsed &&
      typeof parsed === "object" &&
      "id" in parsed &&
      typeof parsed.id === "string"
    ) {
      return parsed.id;
    }
    throw new Error(`unexpected payload: ${payload}`);
  });
};

const latestClient = (): MockRedisClient => {
  const result = vi.mocked(Redis).mock.results.at(-1);
  if (!result || result.type !== "return") {
    throw new Error("expected Redis mock client");
  }
  return result.value as MockRedisClient;
};

const tempDirs: string[] = [];

const writeTempYaml = async (config: unknown): Promise<string> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cascade-redis-list-"));
  tempDirs.push(dir);
  const configPath = path.join(dir, "config.yaml");
  await fs.writeFile(configPath, yaml.stringify(config), "utf8");
  return configPath;
};

describe("RedisListOutput", () => {
  beforeEach(() => {
    stores.length = 0;
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true })),
    );
  });

  describe("Configuration Validation", () => {
    it("should create output with valid configuration", () => {
      expect(() =>
        createRedisListOutput({
          host: "localhost",
          port: 6379,
          key: "tasks",
        }),
      ).not.toThrow();
    });

    it("should support key template interpolation", () => {
      expect(() =>
        createRedisListOutput({
          host: "localhost",
          port: 6379,
          key: "queue:{{content.priority}}",
        }),
      ).not.toThrow();
    });

    it("should default to right direction (RPUSH)", () => {
      expect(() =>
        createRedisListOutput({
          host: "localhost",
          port: 6379,
          key: "tasks",
        }),
      ).not.toThrow();
    });

    it("should support left direction (LPUSH)", () => {
      expect(() =>
        createRedisListOutput({
          host: "localhost",
          port: 6379,
          key: "tasks",
          direction: "left",
        }),
      ).not.toThrow();
    });

    it("should support right direction (RPUSH)", () => {
      expect(() =>
        createRedisListOutput({
          host: "localhost",
          port: 6379,
          key: "tasks",
          direction: "right",
        }),
      ).not.toThrow();
    });

    it("should support max length configuration", () => {
      expect(() =>
        createRedisListOutput({
          host: "localhost",
          port: 6379,
          key: "tasks",
          maxLen: 1000,
        }),
      ).not.toThrow();
    });

    it("should support password authentication", () => {
      expect(() =>
        createRedisListOutput({
          host: "localhost",
          port: 6379,
          key: "tasks",
          password: "secret",
        }),
      ).not.toThrow();
    });

    it("should support database selection", () => {
      expect(() =>
        createRedisListOutput({
          host: "localhost",
          port: 6379,
          key: "tasks",
          db: 2,
        }),
      ).not.toThrow();
    });

    it("should support retry configuration", () => {
      expect(() =>
        createRedisListOutput({
          host: "localhost",
          port: 6379,
          key: "tasks",
          maxRetries: 5,
        }),
      ).not.toThrow();
    });

    it("should support connection pooling options", () => {
      expect(() =>
        createRedisListOutput({
          host: "localhost",
          port: 6379,
          key: "tasks",
          connectTimeout: 5000,
          commandTimeout: 3000,
          keepAlive: 15000,
          lazyConnect: true,
        }),
      ).not.toThrow();
    });
  });

  describe("Validation", () => {
    it("should fail with empty key", () => {
      expect(() =>
        createRedisListOutput({
          host: "localhost",
          port: 6379,
          key: "",
        }),
      ).toThrow();
    });

    it("should fail with invalid hostname", () => {
      expect(() =>
        createRedisListOutput({
          host: "",
          port: 6379,
          key: "tasks",
        }),
      ).toThrow();
    });

    it("should fail with invalid port", () => {
      expect(() =>
        createRedisListOutput({
          host: "localhost",
          port: 99999,
          key: "tasks",
        }),
      ).toThrow();
    });

    it("should fail with negative database number", () => {
      expect(() =>
        createRedisListOutput({
          host: "localhost",
          port: 6379,
          key: "tasks",
          db: -1,
        }),
      ).toThrow();
    });

    it("should fail with negative maxLen", () => {
      expect(() =>
        createRedisListOutput({
          host: "localhost",
          port: 6379,
          key: "tasks",
          maxLen: -1,
        }),
      ).toThrow();
    });

    it("should fail with zero maxLen", () => {
      expect(() =>
        createRedisListOutput({
          host: "localhost",
          port: 6379,
          key: "tasks",
          maxLen: 0,
        }),
      ).toThrow();
    });
  });

  describe("maxLen retention", () => {
    it("default/right RPUSH keeps newest maxLen entries at the tail", async () => {
      const key = "tasks-right";
      const output = createRedisListOutput({
        host: "localhost",
        port: 6379,
        key,
        maxLen: 2,
        // default direction is right
      });

      await Effect.runPromise(output.send(createMessage("A")));
      await Effect.runPromise(output.send(createMessage("B")));
      await Effect.runPromise(output.send(createMessage("C")));

      const store = stores[stores.length - 1]!;
      expect(listIds(store, key)).toEqual(["B", "C"]);

      const client = latestClient();
      expect(client.rpush).toHaveBeenCalled();
      expect(client.ltrim).toHaveBeenCalledWith(key, -2, -1);

      if (output.close) {
        await Effect.runPromise(output.close());
      }
    });

    it("explicit right RPUSH keeps newest maxLen entries at the tail", async () => {
      const key = "tasks-right-explicit";
      const output = createRedisListOutput({
        host: "localhost",
        port: 6379,
        key,
        direction: "right",
        maxLen: 2,
      });

      await Effect.runPromise(output.send(createMessage("A")));
      await Effect.runPromise(output.send(createMessage("B")));
      await Effect.runPromise(output.send(createMessage("C")));

      const store = stores[stores.length - 1]!;
      expect(listIds(store, key)).toEqual(["B", "C"]);

      if (output.close) {
        await Effect.runPromise(output.close());
      }
    });

    it("left LPUSH keeps newest maxLen entries at the head", async () => {
      const key = "tasks-left";
      const output = createRedisListOutput({
        host: "localhost",
        port: 6379,
        key,
        direction: "left",
        maxLen: 2,
      });

      await Effect.runPromise(output.send(createMessage("A")));
      await Effect.runPromise(output.send(createMessage("B")));
      await Effect.runPromise(output.send(createMessage("C")));

      const store = stores[stores.length - 1]!;
      expect(listIds(store, key)).toEqual(["C", "B"]);

      const client = latestClient();
      expect(client.lpush).toHaveBeenCalled();
      expect(client.ltrim).toHaveBeenCalledWith(key, 0, 1);

      if (output.close) {
        await Effect.runPromise(output.close());
      }
    });

    it("YAML max_length decodes via loadConfig and retains newest via buildPipeline", async () => {
      const key = "tasks-yaml-max-length";
      const configPath = await writeTempYaml({
        input: {
          generate: {
            count: 1,
            template: { value: "seed" },
          },
        },
        output: {
          redis_list: {
            host: "localhost",
            port: 6379,
            key,
            max_length: 2,
          },
        },
      });

      const config = await Effect.runPromise(loadConfig(configPath));
      expect(config.output.redis_list?.max_length).toBe(2);

      const pipeline = await Effect.runPromise(buildPipeline(config));
      expect(pipeline.output.name).toBe("redis-list-output");

      await Effect.runPromise(pipeline.output.send(createMessage("A")));
      await Effect.runPromise(pipeline.output.send(createMessage("B")));
      await Effect.runPromise(pipeline.output.send(createMessage("C")));

      const store = stores[stores.length - 1]!;
      expect(listIds(store, key)).toEqual(["B", "C"]);

      const client = latestClient();
      expect(client.rpush).toHaveBeenCalled();
      expect(client.ltrim).toHaveBeenCalledWith(key, -2, -1);

      if (pipeline.output.close) {
        await Effect.runPromise(pipeline.output.close());
      }
      if (pipeline.input.close) {
        await Effect.runPromise(pipeline.input.close());
      }
    });

    it("loadConfig accepts legacy max_len alias and retains newest entries", async () => {
      const key = "tasks-yaml-max-len";
      const configPath = await writeTempYaml({
        input: {
          generate: {
            count: 1,
            template: { value: "seed" },
          },
        },
        output: {
          redis_list: {
            host: "localhost",
            port: 6379,
            key,
            max_len: 2,
          },
        },
      });

      const config = await Effect.runPromise(loadConfig(configPath));
      expect(config.output.redis_list?.max_len).toBe(2);

      const pipeline = await Effect.runPromise(buildPipeline(config));
      expect(pipeline.output.name).toBe("redis-list-output");

      await Effect.runPromise(pipeline.output.send(createMessage("A")));
      await Effect.runPromise(pipeline.output.send(createMessage("B")));
      await Effect.runPromise(pipeline.output.send(createMessage("C")));

      const store = stores[stores.length - 1]!;
      expect(listIds(store, key)).toEqual(["B", "C"]);

      const client = latestClient();
      expect(client.rpush).toHaveBeenCalled();
      expect(client.ltrim).toHaveBeenCalledWith(key, -2, -1);

      if (pipeline.output.close) {
        await Effect.runPromise(pipeline.output.close());
      }
      if (pipeline.input.close) {
        await Effect.runPromise(pipeline.input.close());
      }
    });
  });
});
