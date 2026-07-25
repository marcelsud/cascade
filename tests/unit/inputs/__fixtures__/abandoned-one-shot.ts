// Regression fixture for issue #65: a one-shot file input whose stream is
// never consumed and which is never closed must not keep Node alive.
import { createFileInput } from "../../../../src/inputs/file-input.js";

const filePath = process.argv[2];
if (typeof filePath !== "string" || filePath.length === 0) {
  throw new Error("usage: abandoned-one-shot.ts <filePath>");
}

createFileInput({
  path: filePath,
  follow: false,
  startAt: "beginning",
  pollIntervalMs: 5,
  queueSize: 32,
  overflow: "block",
});
