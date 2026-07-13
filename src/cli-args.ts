export type CliCommand = "run" | "validate" | "test" | string;

export interface ParsedCliArgs {
  readonly command: CliCommand | undefined;
  readonly configPath: string | undefined;
  readonly debug: boolean;
  readonly registryPath: string | undefined;
}

/**
 * Parse the CLI's shared flags while preserving order-independent positional
 * arguments. Flags that consume a value must advance the scan so their value
 * cannot be mistaken for the configuration path.
 */
export const parseCliArgs = (args: ReadonlyArray<string>): ParsedCliArgs => {
  const command = args[0];
  let configPath: string | undefined;
  let debug = false;
  let registryPath: string | undefined;

  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === "--debug") {
      debug = true;
      continue;
    }

    if (argument === "--registry") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("Missing module path after --registry");
      }
      registryPath = value;
      index += 1;
      continue;
    }

    if (!argument.startsWith("-") && configPath === undefined) {
      configPath = argument;
    }
  }

  return { command, configPath, debug, registryPath };
};
