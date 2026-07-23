# File Output

> **Alpha:** This component's configuration shape — in particular `format`,
> `mode`, and their defaults — may change in a backwards-incompatible way
> before it stabilizes. UTF-8 encoding and a trailing newline per record are
> fixed for the alpha version.

## Overview

Writes each message followed by a newline to a local file, producing a
newline-delimited (NDJSON-style) record stream. It shares serialization and the
ordered writable coordinator with the [Stdout output](stdout.md), so record
formats, multiline handling, ordering, backpressure, and metrics behave
identically — only the destination differs.

The file is opened **lazily on the first message**. Construction,
`cascade validate`, and zero-message runs never create or truncate the file.

## Configuration

### Required Fields

- `path`: destination file path. Its **parent directory must already exist** —
  the output validates the parent at construction but never creates directories.

### Optional Fields

- `format`: `content` or `message` (default: `content`)
  - `content`: writes only `message.content`. Strings are written raw (not
    JSON-encoded); everything else is JSON-serialized.
  - `message`: writes the full message envelope (`id`, `correlationId`,
    `timestamp`, `content`, `metadata`, `trace`) as a single JSON line.
- `mode`: `append` or `overwrite` (default: `append`)
  - `append`: adds records to the end of an existing file (creating it if
    missing). Existing content is preserved.
  - `overwrite`: truncates the file **once**, on the first message written.
    A run that writes zero messages never opens the file, so existing content
    is left untouched.

## Examples

### Append NDJSON Records

```yaml
output:
  file:
    path: "./events.ndjson"
    format: content
    mode: append
```

### Full Envelope, Overwrite Each Run

```yaml
output:
  file:
    path: "./events.ndjson"
    format: message
    mode: overwrite
```

### Stdin → File

```yaml
input:
  stdin:
    mode: lines
output:
  file:
    path: "./events.ndjson"
    format: content
```

```bash
printf 'hello\nworld\n' | cascade run pipeline.yaml
cat ./events.ndjson
# {"raw":"hello"}
# {"raw":"world"}
```

The `stdin` input wraps each non-JSON line as `{ "raw": "<line>" }`, so in
`content` format the file output serializes that object as one JSON line per
message. Feed it JSON lines instead and they pass through unchanged.

### File-Input Round-trip

Because `content` format writes each record as a single NDJSON line, a file
produced by this output can be read straight back by the
[file input](../inputs/file.md): the file input JSON-parses each line, so it
reconstructs the same structured content the output serialized. Replaying the
`events.ndjson` above through a file input yields messages whose content equals
`{ raw: "hello" }` and `{ raw: "world" }` — the exact values written here. This
round-trip is lossless for JSON-serializable content; raw multiline strings
(which span physical lines in `content` format) are the exception, so use
`format: message` when you need each record to occupy exactly one line.

## Behavior Notes

- **Multiline content**: in `content` format, raw strings containing `\n` are
  written as-is and therefore span multiple physical lines — only the delimiter
  appended after each message is guaranteed. Use `format: message` for a
  guaranteed one-physical-line-per-message contract (safe NDJSON).
- **Ordering & backpressure**: concurrent sends are written in call order and
  wait for each write to flush, so the file never interleaves partial records.
- **Flush on close**: closing the output drains in-flight writes and closes the
  owned stream, surfacing any close failure.
- **Primary or DLQ**: works unchanged as a primary output or as a DLQ
  destination.

## Error Handling

- Non-serializable content (circular references, BigInt, root
  `undefined`/function/symbol, or a root `toJSON` returning one of those) →
  **logical** error; the record is rejected and no partial line is written.
- Missing parent directory or a non-directory parent → **fatal** error at
  construction, with no filesystem mutation.
- An invalid destination detected when the file is opened (e.g. the target is a
  directory, or permission is denied) → **fatal** error on the first send.
- Runtime write and close failures (e.g. the device fills up) → **intermittent**
  errors, safe to retry.

## Known Limitations (Alpha)

- `format`/`mode` defaults are not yet considered stable; pin them explicitly
  in configs you intend to keep working across upgrades.
- UTF-8 and a trailing newline are fixed; no encoding or delimiter options yet.
- No directory creation, rotation, compression, `fsync` policy, or path
  templating. External rotation of the file while the output is open is
  unsupported.
- CSV output is not implemented; the internals are structured so a future
  `file.format: csv` can reuse this destination without a separate output type.
