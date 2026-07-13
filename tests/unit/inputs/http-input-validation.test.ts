import { describe, expect, it } from "vitest";
import { Effect, Either } from "effect";
import {
  HttpInputError,
  validateHttpInputConfig,
} from "../../../src/inputs/http-input.js";

describe("HTTP input validation", () => {
  it("returns typed validation failures through the error channel", async () => {
    const result = await Effect.runPromise(
      Effect.either(validateHttpInputConfig({ port: 0 })),
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(HttpInputError);
      expect(result.left.category).toBe("logical");
    }
  });
});
