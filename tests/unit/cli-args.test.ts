import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../../src/cli-args.js";

describe("parseCliArgs", () => {
  it.each([
    {
      args: ["run", "--debug", "pipeline.yaml"],
      expected: {
        command: "run",
        configPath: "pipeline.yaml",
        debug: true,
        registryPath: undefined,
      },
    },
    {
      args: ["run", "pipeline.yaml", "--debug"],
      expected: {
        command: "run",
        configPath: "pipeline.yaml",
        debug: true,
        registryPath: undefined,
      },
    },
    {
      args: ["validate", "--registry", "./registry.js", "pipeline.yaml"],
      expected: {
        command: "validate",
        configPath: "pipeline.yaml",
        debug: false,
        registryPath: "./registry.js",
      },
    },
    {
      args: ["validate", "pipeline.yaml", "--registry", "./registry.js"],
      expected: {
        command: "validate",
        configPath: "pipeline.yaml",
        debug: false,
        registryPath: "./registry.js",
      },
    },
  ])("parses $args", ({ args, expected }) => {
    expect(parseCliArgs(args)).toEqual(expected);
  });

  it("does not treat a registry value as the config path", () => {
    expect(
      parseCliArgs(["validate", "--registry", "./registry.js"]),
    ).toMatchObject({ configPath: undefined, registryPath: "./registry.js" });
  });

  it("rejects a registry flag without a value", () => {
    expect(() => parseCliArgs(["validate", "--registry"])).toThrow(
      "Missing module path after --registry",
    );
  });
});
