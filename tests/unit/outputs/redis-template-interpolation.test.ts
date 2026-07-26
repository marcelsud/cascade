import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import Redis from "ioredis";
import { createRedisListOutput } from "../../../src/outputs/redis-list-output.js";
import { createRedisPubSubOutput } from "../../../src/outputs/redis-pubsub-output.js";
import type { Message } from "../../../src/core/types.js";

interface CapturedCall {
  readonly target: string;
  readonly payload: string;
}

interface MockRedisClient {
  status: string;
  lpush: ReturnType<typeof vi.fn>;
  rpush: ReturnType<typeof vi.fn>;
  ltrim: ReturnType<typeof vi.fn>;
  publish: ReturnType<typeof vi.fn>;
  quit: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
}

const captures: CapturedCall[] = [];

vi.mock("ioredis", () => {
  return {
    default: vi.fn(() => {
      const client: MockRedisClient = {
        status: "ready",
        lpush: vi.fn(async () => 1),
        rpush: vi.fn(async (key: string, payload: string) => {
          captures.push({ target: key, payload });
          return 1;
        }),
        ltrim: vi.fn(async () => "OK"),
        publish: vi.fn(async (channel: string, payload: string) => {
          captures.push({ target: channel, payload });
          return 1;
        }),
        quit: vi.fn().mockResolvedValue("OK"),
        disconnect: vi.fn(),
        on: vi.fn(),
      };
      return client;
    }),
  };
});

const baseMessage = (overrides: Partial<Message> = {}): Message => ({
  id: "msg-1",
  content: { type: "order", priority: 3 },
  metadata: { userId: "user-42", region: "us-east" },
  timestamp: 1_700_000_000_000,
  correlationId: "corr-1",
  ...overrides,
});

describe("Redis template interpolation contract", () => {
  beforeEach(() => {
    captures.length = 0;
    vi.clearAllMocks();
  });

  afterEach(async () => {
    // no persistent resources
  });

  it("resolves content and metadata paths identically for list key and pubsub channel", async () => {
    const template = "events:{{content.type}}:{{metadata.userId}}";
    const message = baseMessage();

    const listOutput = createRedisListOutput({
      host: "localhost",
      port: 6379,
      key: template,
      lazyConnect: true,
    });
    const pubsubOutput = createRedisPubSubOutput({
      host: "localhost",
      port: 6379,
      channel: template,
      lazyConnect: true,
    });

    await Effect.runPromise(listOutput.send(message));
    await Effect.runPromise(pubsubOutput.send(message));

    expect(captures).toHaveLength(2);
    expect(captures[0]!.target).toBe("events:order:user-42");
    expect(captures[1]!.target).toBe("events:order:user-42");
    expect(captures[0]!.target).toBe(captures[1]!.target);

    if (listOutput.close) await Effect.runPromise(listOutput.close());
    if (pubsubOutput.close) await Effect.runPromise(pubsubOutput.close());
  });

  it("resolves missing nested paths to empty string for both outputs", async () => {
    const template = "queue:{{content.missing.path}}:{{metadata.absent}}";
    const message = baseMessage({
      content: { type: "order" },
      metadata: { userId: "user-42" },
    });

    const listOutput = createRedisListOutput({
      host: "localhost",
      port: 6379,
      key: template,
      lazyConnect: true,
    });
    const pubsubOutput = createRedisPubSubOutput({
      host: "localhost",
      port: 6379,
      channel: template,
      lazyConnect: true,
    });

    await Effect.runPromise(listOutput.send(message));
    await Effect.runPromise(pubsubOutput.send(message));

    expect(captures).toHaveLength(2);
    expect(captures[0]!.target).toBe("queue::");
    expect(captures[1]!.target).toBe("queue::");
    expect(captures[0]!.target).toBe(captures[1]!.target);

    if (listOutput.close) await Effect.runPromise(listOutput.close());
    if (pubsubOutput.close) await Effect.runPromise(pubsubOutput.close());
  });

  it("stringifies non-string leaf values identically for both outputs", async () => {
    const template = "prio:{{content.priority}}:meta:{{metadata.region}}";
    const message = baseMessage({
      content: { priority: 7 },
      metadata: { region: "eu-west" },
    });

    const listOutput = createRedisListOutput({
      host: "localhost",
      port: 6379,
      key: template,
      lazyConnect: true,
    });
    const pubsubOutput = createRedisPubSubOutput({
      host: "localhost",
      port: 6379,
      channel: template,
      lazyConnect: true,
    });

    await Effect.runPromise(listOutput.send(message));
    await Effect.runPromise(pubsubOutput.send(message));

    expect(captures[0]!.target).toBe("prio:7:meta:eu-west");
    expect(captures[1]!.target).toBe(captures[0]!.target);

    if (listOutput.close) await Effect.runPromise(listOutput.close());
    if (pubsubOutput.close) await Effect.runPromise(pubsubOutput.close());
  });

  it("uses the same JSON envelope payload shape for list and pubsub sends", async () => {
    const message = baseMessage({
      content: { hello: "world" },
      metadata: { a: 1 },
      trace: { traceId: "t1", spanId: "s1" },
    });

    const listOutput = createRedisListOutput({
      host: "localhost",
      port: 6379,
      key: "tasks",
      lazyConnect: true,
    });
    const pubsubOutput = createRedisPubSubOutput({
      host: "localhost",
      port: 6379,
      channel: "events",
      lazyConnect: true,
    });

    await Effect.runPromise(listOutput.send(message));
    await Effect.runPromise(pubsubOutput.send(message));

    expect(JSON.parse(captures[0]!.payload)).toEqual(
      JSON.parse(captures[1]!.payload),
    );

    if (listOutput.close) await Effect.runPromise(listOutput.close());
    if (pubsubOutput.close) await Effect.runPromise(pubsubOutput.close());
  });
});
