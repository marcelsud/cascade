import { describe, expect, it } from "vitest";
import { formatCliFatalError } from "../../src/cli-errors.js";

describe("formatCliFatalError", () => {
  it("uses Error.message", () => {
    expect(formatCliFatalError(new Error("boom"))).toBe("boom");
  });

  it("returns string errors as-is", () => {
    expect(formatCliFatalError("plain")).toBe("plain");
  });

  it("returns Unknown error for nullish non-objects", () => {
    expect(formatCliFatalError(null)).toBe("Unknown error");
    expect(formatCliFatalError(undefined)).toBe("Unknown error");
    expect(formatCliFatalError(12)).toBe("Unknown error");
  });

  it("formats ConfigValidationError with schema details", () => {
    expect(
      formatCliFatalError({
        _tag: "ConfigValidationError",
        message: "Schema validation failed: field x is required",
      }),
    ).toBe("Configuration validation failed\nfield x is required");
  });

  it("formats ConfigValidationError without schema prefix", () => {
    expect(
      formatCliFatalError({
        _tag: "ConfigValidationError",
        message: "bad config",
      }),
    ).toBe("Configuration validation failed: bad config");
  });

  it("formats FileReadError with and without path", () => {
    expect(
      formatCliFatalError({ _tag: "FileReadError", path: "/tmp/x.yaml" }),
    ).toBe("Cannot read file: /tmp/x.yaml");
    expect(formatCliFatalError({ _tag: "FileReadError" })).toBe(
      "Cannot read configuration file",
    );
  });

  it("formats YamlParseError with and without message", () => {
    expect(
      formatCliFatalError({
        _tag: "YamlParseError",
        message: "unexpected end",
      }),
    ).toBe("Invalid YAML syntax: unexpected end");
    expect(formatCliFatalError({ _tag: "YamlParseError" })).toBe(
      "Invalid YAML syntax",
    );
  });

  it("formats generic tagged errors", () => {
    expect(
      formatCliFatalError({ _tag: "OtherError", message: "details" }),
    ).toBe("OtherError: details");
    expect(
      formatCliFatalError({ _tag: "OtherError", error: { code: 1 } }),
    ).toBe('OtherError: {"code":1}');
    expect(formatCliFatalError({ _tag: "OtherError" })).toBe("OtherError");
  });

  it("stringifies untagged objects", () => {
    expect(formatCliFatalError({ foo: 1 })).toBe(
      JSON.stringify({ foo: 1 }, null, 2),
    );
  });
});
