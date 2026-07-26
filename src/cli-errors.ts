/**
 * Format fatal CLI errors for logging.
 * Message text is part of the public CLI contract — keep wording stable.
 */

const formatConfigValidationMessage = (msg: string): string => {
  if (msg.includes("Schema validation failed:")) {
    const parts = msg.split("Schema validation failed:");
    return `Configuration validation failed\n${parts[1]?.trim() || ""}`;
  }
  return `Configuration validation failed: ${msg}`;
};

const formatTaggedCliError = (
  tag: string,
  error: Record<string, unknown>,
): string => {
  if (tag === "ConfigValidationError" && "message" in error) {
    return formatConfigValidationMessage(String(error.message));
  }

  if (tag === "FileReadError") {
    return "path" in error
      ? `Cannot read file: ${error.path}`
      : "Cannot read configuration file";
  }

  if (tag === "YamlParseError") {
    return "message" in error
      ? `Invalid YAML syntax: ${error.message}`
      : "Invalid YAML syntax";
  }

  if ("message" in error) {
    return `${tag}: ${error.message}`;
  }
  if ("error" in error) {
    return `${tag}: ${JSON.stringify(error.error)}`;
  }
  return tag;
};

/**
 * Format a fatal CLI error for logging without changing message content.
 */
export const formatCliFatalError = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (!error || typeof error !== "object") {
    return "Unknown error";
  }

  if ("_tag" in error && typeof error._tag === "string") {
    return formatTaggedCliError(error._tag, error as Record<string, unknown>);
  }

  return JSON.stringify(error, null, 2);
};
