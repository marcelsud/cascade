# Stdin Input

## Overview

Reads records from standard input. The default mode is line-oriented, which makes it suitable for JSONL, shell pipelines, and quick local testing.

## Configuration

### Optional Fields

- `mode`: `lines` or `whole` (default: `lines`)
- `encoding`: Text encoding passed to Node.js (default: `utf8`)
- `queue_size`: Maximum messages buffered in memory (default: `1000`)
- `overflow`: `block`, `drop_new`, or `drop_old` (default: `block`)

With `block`, stdin processing waits for queue capacity. `drop_new` preserves
older buffered records, while `drop_old` preserves the newest records. Drops
are counted in input metrics and warnings are rate-limited.

`block` bounds Cascade's decoded-message queue, but stdin is a push-based Node
stream: raw chunks can still accumulate upstream while a queue offer is waiting.
For sustained producers that cannot be slowed, use a drop policy or rate-limit
the process writing to stdin.

## Examples

### One Line Per Message

```yaml
input:
  stdin:
    mode: lines
```

```bash
printf '{"id":1}\nplain\n' | cascade run pipeline.yaml
```

### Entire Stream as One Message

```yaml
input:
  stdin:
    mode: whole
```

## Message Shape

- In `lines` mode, each line becomes one message and gets `lineNumber` metadata
- In `whole` mode, the full stdin payload becomes a single message on EOF
- Valid JSON is parsed automatically
- Invalid JSON is emitted as `{ raw: "..." }`
