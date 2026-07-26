/**
 * Pure CLI command dispatch helpers.
 * Keeps branching out of the Effect entrypoint so complexity stays low.
 */

type CliUsageFailure = {
  readonly kind: "usage-error";
  readonly lines: readonly string[];
  readonly errorMessage: string;
};

export type CliDispatch =
  | CliUsageFailure
  | { readonly kind: "test"; readonly pattern: string }
  | {
      readonly kind: "validate";
      readonly configPath: string;
      readonly registryPath?: string;
    }
  | {
      readonly kind: "run";
      readonly configPath: string;
      readonly debug: boolean;
      readonly registryPath?: string;
    };

export const isHelpRequest = (args: readonly string[]): boolean =>
  args.length === 0 || args.includes("--help") || args.includes("-h");

export const isVersionRequest = (args: readonly string[]): boolean =>
  args.includes("--version") || args.includes("-v");

export const dispatchCliCommand = (parsed: {
  readonly command: string;
  readonly configPath?: string;
  readonly debug: boolean;
  readonly registryPath?: string;
}): CliDispatch => {
  if (parsed.command === "test") {
    if (!parsed.configPath) {
      return {
        kind: "usage-error",
        lines: [
          "Error: Missing test pattern argument",
          "Usage: cascade test <pattern>",
          'Example: cascade test "tests/**/*.yaml"',
        ],
        errorMessage: "Missing test pattern",
      };
    }
    return { kind: "test", pattern: parsed.configPath };
  }

  if (parsed.command !== "run" && parsed.command !== "validate") {
    return {
      kind: "usage-error",
      lines: [
        `Error: Unknown command '${parsed.command}'`,
        'Run "cascade --help" for usage information.',
      ],
      errorMessage: "Invalid command",
    };
  }

  if (!parsed.configPath) {
    return {
      kind: "usage-error",
      lines: [
        "Error: Missing config file argument",
        `Usage: cascade ${parsed.command} <config-file.yaml>`,
      ],
      errorMessage: "Missing config file",
    };
  }

  if (parsed.command === "validate") {
    return {
      kind: "validate",
      configPath: parsed.configPath,
      registryPath: parsed.registryPath,
    };
  }

  return {
    kind: "run",
    configPath: parsed.configPath,
    debug: parsed.debug,
    registryPath: parsed.registryPath,
  };
};
