import { describe, expect, it } from "vitest";
import { redisOutputOptions } from "../../../src/outputs/redis-output-options.js";

describe("Redis output connection options", () => {
  const base = { host: "localhost", port: 6379 };

  it("disables the offline queue by default", () => {
    expect(redisOutputOptions(base).enableOfflineQueue).toBe(false);
  });

  it("allows explicitly opting back into offline command replay", () => {
    expect(
      redisOutputOptions({ ...base, enableOfflineQueue: true })
        .enableOfflineQueue,
    ).toBe(true);
  });
});
