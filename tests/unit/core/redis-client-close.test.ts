import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeRedisClient,
  type RedisClient,
} from "../../../src/core/redis-client.js";

const clientWithQuit = (quit: () => Promise<unknown>): RedisClient => ({
  status: "ready",
  quit: vi.fn(quit),
  disconnect: vi.fn(),
});

describe("Redis ready-client release failures", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("force-disconnects after rejecting QUIT and preserves the original close error", async () => {
    const failure = new Error("Command timed out");
    const client = clientWithQuit(async () => {
      throw failure;
    });
    await expect(closeRedisClient(client)).rejects.toBe(failure);
    expect(client.disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a never-settling QUIT to one second and releases the client", async () => {
    const client = clientWithQuit(() => new Promise(() => {}));
    let completed = false;
    let failure: unknown;
    const closing = closeRedisClient(client).then(
      () => {
        completed = true;
      },
      (error) => {
        completed = true;
        failure = error;
      },
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(completed, "client release must not wait forever for QUIT").toBe(
      true,
    );
    await closing;
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("QUIT timed out");
    expect(client.disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("observes a late QUIT rejection after timeout without releasing twice", async () => {
    let rejectQuit!: (error: Error) => void;
    const client = clientWithQuit(
      () =>
        new Promise((_resolve, reject) => {
          rejectQuit = reject;
        }),
    );
    let completed = false;
    const closing = closeRedisClient(client).catch((error: unknown) => {
      completed = true;
      return error;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(
      completed,
      "timeout must settle the close before a late QUIT rejection",
    ).toBe(true);
    expect(await closing).toBeInstanceOf(Error);
    rejectQuit(new Error("late network failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(client.disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels the deadline after a successful QUIT without forced disconnect", async () => {
    const client = clientWithQuit(async () => "OK");
    await expect(closeRedisClient(client)).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(client.quit).toHaveBeenCalledOnce();
    expect(client.disconnect).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
