# Stdin Input

## Overview

Reads records from standard input. The default mode is line-oriented, which makes it suitable for JSONL, shell pipelines, and quick local testing.

## Configuration

### Optional Fields

- `mode`: `lines` or `whole` (default: `lines`)
- `encoding`: Text encoding passed to Node.js (default: `utf8`)

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
