import { describe, expect, it } from "vitest";
import {
  dispatchCliCommand,
  isHelpRequest,
  isVersionRequest,
} from "../../src/cli-dispatch.js";

describe("cli-dispatch", () => {
  it("detects help and version flags", () => {
    expect(isHelpRequest([])).toBe(true);
    expect(isHelpRequest(["--help"])).toBe(true);
    expect(isHelpRequest(["-h"])).toBe(true);
    expect(isHelpRequest(["run", "x.yaml"])).toBe(false);
    expect(isVersionRequest(["--version"])).toBe(true);
    expect(isVersionRequest(["-v"])).toBe(true);
    expect(isVersionRequest(["run"])).toBe(false);
  });

  it("dispatches test patterns and missing pattern usage errors", () => {
    expect(
      dispatchCliCommand({
        command: "test",
        configPath: "tests/**/*.yaml",
        debug: false,
      }),
    ).toEqual({ kind: "test", pattern: "tests/**/*.yaml" });

    const missing = dispatchCliCommand({ command: "test", debug: false });
    expect(missing.kind).toBe("usage-error");
    if (missing.kind === "usage-error") {
      expect(missing.errorMessage).toBe("Missing test pattern");
      expect(missing.lines[0]).toContain("Missing test pattern argument");
    }
  });

  it("dispatches unknown command and missing config usage errors", () => {
    const unknown = dispatchCliCommand({ command: "wat", debug: false });
    expect(unknown.kind).toBe("usage-error");
    if (unknown.kind === "usage-error") {
      expect(unknown.errorMessage).toBe("Invalid command");
      expect(unknown.lines[0]).toContain("Unknown command 'wat'");
    }

    const missingConfig = dispatchCliCommand({ command: "run", debug: true });
    expect(missingConfig.kind).toBe("usage-error");
    if (missingConfig.kind === "usage-error") {
      expect(missingConfig.errorMessage).toBe("Missing config file");
    }
  });

  it("dispatches validate and run with registry path", () => {
    expect(
      dispatchCliCommand({
        command: "validate",
        configPath: "p.yaml",
        debug: false,
        registryPath: "./reg.js",
      }),
    ).toEqual({
      kind: "validate",
      configPath: "p.yaml",
      registryPath: "./reg.js",
    });
    expect(
      dispatchCliCommand({
        command: "run",
        configPath: "p.yaml",
        debug: true,
      }),
    ).toEqual({
      kind: "run",
      configPath: "p.yaml",
      debug: true,
      registryPath: undefined,
    });
  });
});
