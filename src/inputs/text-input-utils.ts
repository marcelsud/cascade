import type { Message } from "../core/types.js";
import { createMessage } from "../core/types.js";

const parseTextContent = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return { raw: value };
  }
};

export const createTextMessage = (
  value: string,
  metadata: Record<string, unknown>,
): Message => createMessage(parseTextContent(value), metadata);

export const splitCompleteLines = (
  buffer: string,
): readonly [readonly string[], string] => {
  const segments = buffer.split("\n");
  const trailing = segments.pop() ?? "";
  const lines = segments.map((segment) =>
    segment.endsWith("\r") ? segment.slice(0, -1) : segment,
  );

  return [lines, trailing];
};
