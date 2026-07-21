# Stdout Output

> **Alpha:** This component's configuration shape — in particular `format`
> and its default — may change in a backwards-incompatible way before it
> stabilizes. Data written to stdout currently shares the stream with
> CLI/pipeline log lines; there is no log/data separation yet, so piping
> output to tools like `jq` may see log lines interleaved with data.

## Overview

Writes each message followed by a newline to standard output. Useful for
local debugging, quick pipelines (`stdin → stdout`), and composing with
shell tools. In `content` format, raw strings are written exactly as-is —
if the string itself contains newlines, it spans multiple physical lines;
only the delimiter appended after the message is guaranteed.

## Configuration

### Optional Fields

- `format`: `content` or `message` (default: `content`)
  - `content`: prints only `message.content`. Strings are written raw
    (not JSON-encoded); everything else is JSON-serialized.
  - `message`: prints the full message envelope (`id`, `correlationId`,
    `timestamp`, `content`, `metadata`, `trace`) as JSON.

## Examples

### Plain Text Passthrough

```yaml
output:
  stdout:
    format: content
```

Given a string message `"hello"`, prints:
```
hello
```

### Full Envelope

```yaml
output:
  stdout:
    format: message
```

Given the same message, prints:
```json
{"id":"...","timestamp":1705318200000,"content":"hello","metadata":{}}
```

### Multiline String Content

```yaml
output:
  stdout:
    format: content
```

Given a string message `"first\nsecond"`, prints (two physical lines, one message):
```
first
second
```

For a guaranteed one-physical-line-per-message contract (e.g. safe JSONL),
use `format: message` instead, which always emits a single-line JSON object.

### Stdin → Stdout Pipeline

```yaml
input:
  stdin:
    mode: lines
output:
  stdout:
    format: content
```

```bash
printf 'hello\nworld\n' | cascade run pipeline.yaml
```

## Known Limitations (Alpha)

- No stderr/stdout separation for logs — data and log lines are interleaved.
- `format` default (`content`) is not yet considered stable; pin it
  explicitly in configs you intend to keep working across upgrades.
- `content` format does not guarantee one physical line per message: raw
  strings containing `\n` are written as-is. Use `format: message` if you
  need each message to occupy exactly one line.
