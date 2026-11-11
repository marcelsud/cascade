import { beforeEach, describe, expect, it, vi } from "vitest";
import { Chunk, Effect, Option, Stream } from "effect";
import { createRedisStreamsInput } from "../../../src/inputs/redis-streams-input.js";
import { run } from "../../../src/core/pipeline.js";
import { createCaptureOutput } from "../../../src/testing/capture-output.js";

type Entry = [string, string[] | null];
const state = vi.hoisted(() => ({
  pending: [] as Entry[],
  fresh: [] as Entry[],
  cursors: [] as string[],
  acknowledgements: [] as string[],
}));

vi.mock("ioredis", () => ({
  default: vi.fn(() => ({
    status: "ready",
    on: vi.fn(),
    xgroup: vi.fn(async () => "OK"),
    xreadgroup: vi.fn(async (...args: unknown[]) => {
      const cursor = String(args.at(-1));
      const count = Number(args[args.indexOf("COUNT") + 1]);
      state.cursors.push(cursor);
      let entries: Entry[];
      if (cursor === ">") {
        entries = state.fresh.splice(0, count);
        state.pending.push(...entries);
        if (entries.length === 0) {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return null;
        }
      } else {
        const [cursorMs, cursorSequence = 0n] = cursor.split("-").map(BigInt);
        entries = state.pending
          .filter(([id]) => {
            const [ms, sequence] = id.split("-").map(BigInt);
            return (
              ms > cursorMs || (ms === cursorMs && sequence > cursorSequence)
            );
          })
          .slice(0, count);
      }
      return [["pending-stream", entries]];
    }),
    xack: vi.fn(async (_stream: string, _group: string, id: string) => {
      state.acknowledgements.push(id);
      state.pending = state.pending.filter(([entryId]) => entryId !== id);
      return 1;
    }),
    quit: vi.fn(async () => "OK"),
    disconnect: vi.fn(),
  })),
}));

const entry = (id: string): Entry => [id, ["content", JSON.stringify({ id })]];
const inputFor = (count = 1) =>
  createRedisStreamsInput({
    host: "localhost",
    port: 6379,
    stream: "pending-stream",
    mode: "consumer-group",
    consumerGroup: "pending-group",
    consumerName: "stable-consumer",
    startId: "0",
    count,
    blockMs: 5,
  });

const collect = async (size: number, count = 1) => {
  const input = inputFor(count);
  try {
    const result = await Effect.runPromise(
      input.stream.pipe(
        Stream.take(size),
        Stream.runCollect,
        Effect.timeoutOption("300 millis"),
      ),
    );
    expect(
      Option.isSome(result),
      `pending entries must be replayed; cursors=${JSON.stringify(state.cursors)}`,
    ).toBe(true);
    return Option.isSome(result) ? Chunk.toReadonlyArray(result.value) : [];
  } finally {
    await Effect.runPromise(input.close!());
  }
};

describe("Redis Streams same-consumer pending recovery", () => {
  beforeEach(() => {
    state.pending = [];
    state.fresh = [];
    state.cursors = [];
    state.acknowledgements = [];
  });

  it("replays the failed delivery after a same-consumer restart and ACKs only successful delivery", async () => {
    state.fresh = [entry("1-0")];
    const failedRun = () => {
      const input = inputFor();
      return run({
        name: "pending-failed-delivery",
        input: { ...input, stream: input.stream.pipe(Stream.take(1)) },
        processors: [],
        output: {
          name: "failed-output",
          send: () => Effect.fail(new Error("delivery failed")),
        },
      }).pipe(Effect.timeoutOption("300 millis"));
    };
    const first = await Effect.runPromise(failedRun());
    expect(Option.isSome(first)).toBe(true);
    if (Option.isSome(first)) expect(first.value.stats.failed).toBe(1);
    expect(state.pending.map(([id]) => id)).toEqual(["1-0"]);
    expect(state.acknowledgements).toEqual([]);

    const second = await Effect.runPromise(failedRun());
    expect(
      Option.isSome(second),
      "same-consumer restart must receive its unacknowledged work",
    ).toBe(true);
    if (Option.isSome(second)) expect(second.value.stats.failed).toBe(1);
    expect(state.pending.map(([id]) => id)).toEqual(["1-0"]);
    expect(state.acknowledgements).toEqual([]);

    const input = inputFor();
    const capture = await Effect.runPromise(createCaptureOutput());
    const delivered = await Effect.runPromise(
      run({
        name: "pending-successful-delivery",
        input: { ...input, stream: input.stream.pipe(Stream.take(1)) },
        processors: [],
        output: capture,
      }).pipe(Effect.timeoutOption("300 millis")),
    );
    expect(Option.isSome(delivered)).toBe(true);
    if (Option.isSome(delivered)) expect(delivered.value.success).toBe(true);
    const messages = await Effect.runPromise(capture.getMessages());
    expect(messages.map((message) => message.content)).toEqual([{ id: "1-0" }]);
    expect(state.acknowledgements).toEqual(["1-0"]);
    expect(state.pending).toEqual([]);
  });

  it("advances through pending batches once before switching to new entries", async () => {
    state.pending = [entry("9-0"), entry("10-0"), entry("11-0")];
    state.fresh = [entry("12-0")];
    const messages = await collect(4, 2);
    expect(messages.map((message) => message.metadata.externalId)).toEqual([
      "9-0",
      "10-0",
      "11-0",
      "12-0",
    ]);
    expect(state.cursors).toEqual(["0", "10-0", "11-0", ">"]);
    expect(state.acknowledgements).toEqual([]);
  });

  it("switches an empty pending range to the blocking new-entry cursor", async () => {
    state.fresh = [entry("1-0")];
    const messages = await collect(1);
    expect(messages.map((message) => message.metadata.externalId)).toEqual([
      "1-0",
    ]);
    expect(state.cursors).toEqual(["0", ">"]);
  });

  it("advances past deleted pending payloads without fabricating a message or looping", async () => {
    state.pending = [["1-0", null], entry("2-0")];
    const messages = await collect(1);
    expect(messages.map((message) => message.metadata.externalId)).toEqual([
      "2-0",
    ]);
    expect(state.cursors).toEqual(["0", "1-0"]);
    expect(state.acknowledgements).toEqual([]);
  });
});
