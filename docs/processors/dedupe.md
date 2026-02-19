# Dedupe Processor

## Overview

Deduplicates messages by a configured attribute key during pipeline processing. Prevents repeated processing side effects when upstream systems (webhooks, queues, retries, at-least-once delivery) re-deliver the same logical event. Duplicate messages are suppressed and never reach downstream processors or outputs.

**Scope**: Process-local only. Dedupe state is held in-memory within the running process and is not shared across multiple instances or persisted across restarts.

## Configuration

### Required Fields

- `key`: Attribute path used to extract the deduplication key. Supports payload paths (e.g. `orderId`, `event.id`) and metadata references (e.g. `metadata.correlationId`).

### Optional Fields

- `window_ms`: Retention window in milliseconds. Keys older than this are evicted and can be reprocessed. Default: `60000` (60 seconds).
- `max_keys`: Maximum number of keys held in memory. When exceeded, oldest entries are evicted first. Default: `10000`.

## Examples

### Basic Payload Key

```yaml
pipeline:
  processors:
    - dedupe:
        key: "orderId"
```

### Metadata Key

```yaml
pipeline:
  processors:
    - dedupe:
        key: "metadata.correlationId"
```

### Nested Payload Path

```yaml
pipeline:
  processors:
    - dedupe:
        key: "event.header.messageId"
```

### Custom Window and Bounds

```yaml
pipeline:
  processors:
    - dedupe:
        key: "transactionId"
        window_ms: 300000   # 5 minutes
        max_keys: 50000
```

### Combined with Other Processors

```yaml
pipeline:
  processors:
    - metadata:
        correlation_id_field: "correlationId"
        add_timestamp: true

    - dedupe:
        key: "metadata.correlationId"
        window_ms: 120000

    - mapping:
        expression: |
          { "processed": $uppercase(name) }

    - log:
        level: "info"
        include_content: false
```

## Features

- **Attribute-Based Deduplication**: Extract dedupe key from any payload path or metadata field
- **Duplicate Suppression**: Duplicate messages are dropped and never forwarded downstream
- **Configurable Time Window**: Control how long keys are retained before expiring
- **Memory-Bounded**: `max_keys` cap prevents unbounded memory growth in long-running pipelines
- **Automatic Eviction**: Expired keys and overflow entries are evicted on each processed message
- **Observability**: Structured logs and metrics for dedupe hits, misses, and extraction failures
- **Typed Errors**: Key extraction failures produce `DedupeKeyExtractionError` with actionable context

## Key Extraction

The processor determines where to extract the key based on the configured `key` value:

1. **Metadata reference** — when `key` starts with `metadata.`, the remainder is used as a dot-path into the message metadata. Example: `metadata.headers.contentType` traverses `msg.metadata.headers.contentType`.

2. **Payload path** — otherwise, the `key` is used as a dot-path into the message content (payload). Example: `event.id` traverses `msg.content.event.id`.

Extracted values are stringified before comparison. If the path resolves to `undefined` or `null`, the processor fails with a `DedupeKeyExtractionError` containing the configured key path, message ID, and reason.

## Duplicate Handling

- **First-seen keys**: The message passes through to downstream processors/outputs. The key is recorded with its first-seen timestamp.
- **Duplicate keys**: The message is suppressed — it returns an empty result and is never forwarded downstream.
- **Expired keys**: After `window_ms` elapses, the key is evicted and the same key will be treated as first-seen again.

## Memory Management

The processor bounds memory usage through two eviction strategies that run on every processed message:

1. **Window expiration**: Entries older than `window_ms` are removed before the duplicate check.
2. **Overflow eviction**: After inserting a new key, if the state exceeds `max_keys`, the oldest entries (by insertion order) are evicted until the size is within bounds.

### Sizing Guidance

| Scenario | Suggested `window_ms` | Suggested `max_keys` |
|---|---|---|
| Low-volume webhook retries | `60000` (1 min) | `1000` |
| Standard queue dedup | `300000` (5 min) | `10000` |
| High-volume event stream | `60000` (1 min) | `50000` |
| Long-tail retry patterns | `3600000` (1 hour) | `100000` |

## Metrics and Observability

The dedupe processor emits structured metrics following the same pattern as other Cascade components:

| Metric | Description |
|---|---|
| `dedupeHits` | Number of duplicate messages suppressed |
| `dedupeMisses` | Number of first-seen messages passed through |
| `extractionFailures` | Number of key extraction failures |
| `activeKeys` | Current number of keys held in memory |

### Log Events

- **Dedupe hit** (`debug`): Logged when a duplicate is suppressed, includes `keyPath`, `dedupeKey`, and `messageId`.
- **Dedupe miss** (`debug`): Logged when a first-seen key is accepted, includes `keyPath`, `dedupeKey`, and `messageId`.
- **Key extraction failure** (`warn`): Logged when key extraction yields `undefined`/`null`, includes `keyPath`, `reason`, and `messageId`.

Use `--debug` flag when running Cascade to see debug-level dedupe events.

## Scope and Limitations

- **Process-local only**: Dedupe state exists only within the running process. If you run multiple instances of the same pipeline, each maintains its own independent dedupe state — duplicates may still reach downstream if delivered to different instances.
- **No persistence**: State is lost on process restart. After a restart, previously seen keys will be treated as first-seen again until the window expires.
- **No distributed coordination**: There is no shared store (Redis, database) backing the dedupe state in this version.
- **Scalar keys only**: The extracted key value is stringified via `String()`. Objects and arrays are converted to their string representation, which may not produce stable or meaningful dedupe keys.

## Use Cases

- Suppressing webhook retry duplicates
- Preventing double-processing of at-least-once queue messages (SQS, Redis Streams)
- Filtering repeated events in event-driven architectures
- Guarding idempotent downstream APIs from duplicate calls
- Cleaning noisy upstream data sources with retransmissions

## Best Practices

- **Place dedupe early** in your processor chain, before side-effect-producing processors or outputs
- **Choose stable keys**: Use fields that uniquely identify the logical event (e.g. `orderId`, `eventId`, `correlationId`) rather than volatile fields
- **Size the window appropriately**: Match `window_ms` to your upstream retry/redelivery pattern — too short may miss late duplicates, too long increases memory usage
- **Monitor metrics**: Watch `dedupeHits` and `activeKeys` to tune `window_ms` and `max_keys` for your workload
- **Use metadata keys** when your input processor (e.g. metadata processor) already assigns unique identifiers

## Troubleshooting

### Messages not being deduplicated

- Verify the `key` path matches your message structure exactly (case-sensitive, dot-separated)
- Check that the key field has the same value across duplicates — different values produce different dedupe keys
- Ensure `window_ms` is long enough for your retry interval
- Use `--debug` to see dedupe hit/miss log events with extracted key values

### Unexpected key extraction failures

When the configured `key` path cannot be resolved, the processor fails with a `DedupeKeyExtractionError` and logs a warning. The error message includes all context needed for diagnosis:

```
Dedupe key extraction failed: path "orderId" on message msg-abc123 — payload path "orderId" not found or null
```

```
Dedupe key extraction failed: path "metadata.correlationId" on message msg-abc123 — metadata field "correlationId" not found or null
```

**Common causes and fixes:**

| Symptom | Cause | Fix |
|---|---|---|
| `payload path "X" not found or null` | Key field missing from message content | Verify upstream sends the expected field; check for typos in the key path |
| `metadata field "X" not found or null` | Metadata field not populated | Ensure the metadata processor runs **before** the dedupe processor in your pipeline |
| Failures on nested paths like `event.header.id` | Intermediate object is missing or null | Verify the full object path exists — if `event` or `event.header` is missing, extraction fails |
| Failures on all messages | Message content is not a JSON object | Dedupe cannot traverse strings, arrays, or null payloads; ensure content is an object |
| Intermittent failures | Some messages lack the key field | Add validation upstream or use a key that is guaranteed to exist on all messages |

**Diagnosing in debug mode:**

Run your pipeline with `--debug` to see extraction attempts:

```bash
cascade run pipeline.yaml --debug
```

The warning log for a failed extraction includes structured annotations:

```json
{
  "level": "warn",
  "message": "Dedupe key extraction failed for message msg-abc123",
  "keyPath": "orderId",
  "reason": "payload path \"orderId\" not found or null",
  "messageId": "msg-abc123"
}
```

**Tips:**

- For metadata keys, always use the `metadata.` prefix (e.g. `metadata.correlationId`, not just `correlationId`)
- Bare `metadata.` (with nothing after the dot) is invalid and will always fail extraction
- Key values are stringified with `String()` — objects and arrays produce unstable string representations like `[object Object]`; use scalar fields for reliable deduplication

### High memory usage

- Reduce `window_ms` to evict keys sooner
- Lower `max_keys` to cap in-memory entries
- Monitor `activeKeys` metric to understand steady-state memory usage
- Consider whether your key space has high cardinality (many unique keys)

### Duplicates still reaching output after restart

- This is expected — dedupe state is process-local and not persisted
- After restart, the dedupe window starts empty and previously seen keys will pass through
- For restart-resilient deduplication, implement idempotency at the output/consumer layer

### Observability and monitoring

The dedupe processor exposes metrics and structured log events that help you understand deduplication behavior at runtime.

#### Reading dedupe metrics

The processor tracks four counters accessible via `getMetrics()`:

| Metric | What it tells you |
|---|---|
| `dedupeHits` | Total duplicate messages suppressed since process start |
| `dedupeMisses` | Total first-seen messages passed through since process start |
| `extractionFailures` | Total key extraction failures since process start |
| `activeKeys` | Current number of keys held in dedupe state (point-in-time) |

Metrics are emitted via structured logging following the same pattern as other Cascade components:

```json
{
  "level": "info",
  "message": "Component metrics",
  "component": "dedupe-processor",
  "type": "processor",
  "dedupeHits": 142,
  "dedupeMisses": 58,
  "extractionFailures": 0,
  "activeKeys": 58,
  "timestamp": 1706000000000
}
```

#### Interpreting metric patterns

| Pattern | Interpretation | Action |
|---|---|---|
| High `dedupeHits`, low `dedupeMisses` | Most messages are duplicates | Expected for retry-heavy sources; verify upstream is not stuck in a loop |
| Zero `dedupeHits` | No duplicates detected | Either no duplicates exist or `window_ms` is too short and keys expire before retries arrive |
| Rising `extractionFailures` | Key path misconfigured or messages malformed | Check the `key` config and incoming message structure (see key extraction failures above) |
| `activeKeys` near `max_keys` | State is at capacity; oldest keys being evicted | Increase `max_keys` if you need longer retention, or reduce `window_ms` to expire keys faster |
| `activeKeys` stays low despite volume | Keys are expiring quickly | Expected if `window_ms` is short relative to throughput |

#### Debug log events

With `--debug`, the processor emits a log event for every processed message:

**Dedupe hit** (duplicate suppressed):

```json
{
  "level": "debug",
  "message": "Dedupe hit: duplicate suppressed",
  "keyPath": "orderId",
  "dedupeKey": "ORD-12345",
  "messageId": "msg-abc123"
}
```

**Dedupe miss** (first-seen, passed through):

```json
{
  "level": "debug",
  "message": "Dedupe miss: first-seen key accepted",
  "keyPath": "orderId",
  "dedupeKey": "ORD-12345",
  "messageId": "msg-def456"
}
```

**Key extraction failure** (always logged at `warn`, even without `--debug`):

```json
{
  "level": "warn",
  "message": "Dedupe key extraction failed for message msg-ghi789",
  "keyPath": "metadata.correlationId",
  "reason": "metadata field \"correlationId\" not found or null",
  "messageId": "msg-ghi789"
}
```

#### Integration with log aggregation

Dedupe log events use structured JSON and include `keyPath`, `dedupeKey`, and `messageId` fields. These can be used to:

- **Filter by key path** to isolate specific dedupe processors in multi-processor pipelines
- **Count by dedupeKey** to identify which keys produce the most duplicates
- **Alert on extractionFailures** to catch configuration drift or schema changes
- **Track activeKeys over time** to validate memory bounds and tune `window_ms`/`max_keys`

Example log aggregation queries (conceptual):

```
# Find all extraction failures in the last hour
level:warn AND message:"Dedupe key extraction failed"

# Count duplicates by key value
level:debug AND message:"Dedupe hit" | stats count by dedupeKey

# Monitor active key count trend
message:"Component metrics" AND component:"dedupe-processor" | timechart avg(activeKeys)
```

## See Also

- [Metadata Processor](metadata.md) - Add correlation IDs usable as dedupe keys
- [Logging Processor](logging.md) - Debug message flow around deduplication
- [Mapping Processor](mapping.md) - Transform messages after deduplication
- [Branch Processor](branch.md) - Route messages conditionally after dedup
