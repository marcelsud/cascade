# File Input

## Overview

Reads newline-delimited records from a local file. By default it behaves like `tail -f`: it starts at the end of the file and emits only newly appended complete lines.

## Configuration

### Required Fields

- `path`: Path to the file to read

### Optional Fields

- `follow`: Continue polling for appended lines (default: `true`)
- `start_at`: Where to begin reading, `end` or `beginning` (default: `end`)
- `poll_interval_ms`: Poll interval while following (default: `500`)
- `encoding`: Text encoding passed to Node.js (default: `utf8`)
- `queue_size`: Maximum messages buffered in memory (default: `1000`)
- `overflow`: `block`, `drop_new`, or `drop_old` (default: `block`)

With `block`, file polling waits for queue capacity. `drop_new` preserves older
buffered lines, while `drop_old` preserves the newest lines. Drops are counted
in input metrics and warnings are rate-limited.

## Examples

### Tail a Log File

```yaml
input:
  file:
    path: "/var/log/app/events.log"
```

### Replay a File Once

```yaml
input:
  file:
    path: "./fixtures/events.jsonl"
    follow: false
    start_at: beginning
```

## Message Shape

- Each complete line becomes one message
- Valid JSON lines are parsed into structured content
- Invalid JSON lines are emitted as `{ raw: "..." }`
- Metadata includes `source`, `path`, `lineNumber`, and `readAt`

## Notes

- Partial trailing lines are held until a newline arrives
- If the file is truncated or rotated while following, Cascade restarts from the current file contents
- Stat and read use the same open descriptor, so rotation between them cannot mix file identities
