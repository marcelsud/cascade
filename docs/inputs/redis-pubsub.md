# Redis Pub/Sub Input

## Overview

Subscribes to Redis Pub/Sub channels or patterns and consumes published messages in real-time. Supports both exact channel subscription (SUBSCRIBE) and pattern matching (PSUBSCRIBE) for flexible message routing.

## Configuration

### Required Fields

- `url`: Redis connection URL (e.g., "redis://localhost:6379")
- One of:
  - `channels`: Array of channel names to subscribe to (exact match)
  - `patterns`: Array of channel patterns to subscribe to (glob-style matching)
  - Both can be provided together

### Optional Fields

- `queue_size`: Maximum messages buffered in memory (default: 1000)
- `overflow`: `block`, `drop_new`, or `drop_old` (default: `block`)

`block` waits for queue capacity instead of silently discarding messages.
`drop_new` preserves older buffered messages, while `drop_old` preserves the
newest messages. Explicit drops increment `messagesDropped` and emit
rate-limited warnings.

### Connection Configuration Fields

- `connect_timeout`: Connection timeout in ms (default: 10000)
- `command_timeout`: Command timeout in ms (optional)
- `keep_alive`: TCP keep-alive in ms (default: 30000)
- `lazy_connect`: Defer connection until first command (default: false)
- `max_retries_per_request`: Max retries per request (default: 20)
- `enable_offline_queue`: Queue commands when offline (default: true)

## Examples

### Basic Channel Subscription

```yaml
input:
  redis_pubsub:
    url: "redis://localhost:6379"
    channels:
      - "events"
      - "notifications"
      - "alerts"
```

### Pattern Subscription

```yaml
input:
  redis_pubsub:
    url: "redis://localhost:6379"
    patterns:
      - "events:*"
      - "logs:*"
      - "metrics:server:*"
```

### Mixed Channels and Patterns

```yaml
input:
  redis_pubsub:
    url: "redis://localhost:6379"
    channels:
      - "global-events"  # Exact channel
    patterns:
      - "user:*"         # All user channels
      - "team:*:events"  # All team event channels
```

### With Queue Size Limit

```yaml
input:
  redis_pubsub:
    url: "redis://localhost:6379"
    channels:
      - "high-volume-events"
    queue_size: 500  # Buffer up to 500 messages
```

### Authenticated Redis

```yaml
input:
  redis_pubsub:
    url: "redis://:password@redis.example.com:6379/0"
    channels:
      - "secure-channel"
```

### Production Configuration

```yaml
input:
  redis_pubsub:
    url: "redis://production-redis:6379"
    channels:
      - "production-events"
    patterns:
      - "alerts:*"

    # High availability settings
    connect_timeout: 10000
    command_timeout: 5000
    keep_alive: 30000
    max_retries_per_request: 20
    enable_offline_queue: true

    # Larger queue for high-throughput
    queue_size: 1000
```

## Features

- **Channel Subscription**: Subscribe to exact channel names using SUBSCRIBE
- **Pattern Matching**: Subscribe to channel patterns using PSUBSCRIBE (e.g., "events:*")
- **Mixed Mode**: Support both channels and patterns simultaneously
- **Message Buffering**: In-memory queue prevents message loss during processing spikes
- **Automatic Reconnection**: Built-in retry logic for connection failures
- **Zero Data Loss**: Messages queued in memory if processing falls behind
- **Metadata Enrichment**: Each message includes channel name and pattern (if matched)

## Message Format

Messages received from Redis Pub/Sub are automatically parsed as JSON. The input enriches messages with metadata:

```javascript
{
  "id": "generated-uuid",
  "content": { /* parsed JSON from Redis */ },
  "metadata": {
    "source": "redis-pubsub-input",
    "channel": "events",        // Channel where message was published
    "pattern": "events:*",      // Pattern matched (if using PSUBSCRIBE)
    "receivedAt": "2024-01-15T10:30:00.000Z"
  },
  "timestamp": 1705318200000
}
```

## Use Cases

### Event Broadcasting
Subscribe to application events published to Redis:
```yaml
input:
  redis_pubsub:
    url: "redis://localhost:6379"
    channels:
      - "app-events"
```

### Multi-Tenant Pattern Matching
Route messages from different tenants:
```yaml
input:
  redis_pubsub:
    url: "redis://localhost:6379"
    patterns:
      - "tenant:*:events"
      - "tenant:*:notifications"
```

### Microservice Communication
Subscribe to events from multiple services:
```yaml
input:
  redis_pubsub:
    url: "redis://localhost:6379"
    patterns:
      - "service:auth:*"
      - "service:payments:*"
      - "service:orders:*"
```

### Log Aggregation
Collect logs from different sources:
```yaml
input:
  redis_pubsub:
    url: "redis://localhost:6379"
    patterns:
      - "logs:*:error"
      - "logs:*:warning"
```

## Troubleshooting

### No Messages Received

1. **Check Publisher**: Ensure messages are being published to the channel
   ```bash
   redis-cli PUBLISH events '{"test": "message"}'
   ```

2. **Verify Subscription**: Check that channels/patterns are correctly configured
   ```bash
   redis-cli PUBSUB CHANNELS
   redis-cli PUBSUB NUMPAT
   ```

3. **Check Connection**: Verify Redis URL and authentication
   ```bash
   redis-cli -h localhost -p 6379 PING
   ```

### Queue Full Warnings

If you see "Message queue full" warnings:
- Increase `queue_size` for higher throughput
- Optimize downstream processors to consume faster
- Consider adding backpressure configuration to the pipeline

### Pattern Not Matching

Redis patterns use glob-style matching:
- `*` matches any sequence of characters within a segment
- `?` matches a single character
- `[abc]` matches any character from the set

Examples:
- `events:*` matches `events:user`, `events:order`, but NOT `events:user:login`
- `events:*:*` matches `events:user:login`, `events:order:created`
- `logs:*.error` matches `logs:app.error`, `logs:api.error`

### Connection Issues

For connection problems:
1. Increase `connect_timeout` and `command_timeout`
2. Enable `enable_offline_queue` to buffer commands during reconnection
3. Check network connectivity and firewall rules
4. Verify Redis server is accepting connections

## Performance Considerations

- **Pub/Sub is Fire-and-Forget**: Messages published while no subscribers are connected are lost
- **Message Size**: Large messages impact throughput; consider compressing content
- **Queue Size**: Balance memory usage vs. message loss risk
- **Pattern Matching**: PSUBSCRIBE is slightly slower than SUBSCRIBE; use exact channels when possible
- **Connection Overhead**: Reuse connections when possible; avoid creating multiple inputs for the same Redis instance

## Comparison with Redis Streams

| Feature | Pub/Sub | Streams |
|---------|---------|---------|
| Message Persistence | No | Yes |
| Consumer Groups | No | Yes |
| Message History | No | Yes (with trimming) |
| At-least-once Delivery | No | Yes |
| Pattern Matching | Yes | No |
| Fan-out Performance | Excellent | Good |

**When to use Pub/Sub:**
- Real-time event broadcasting
- Fire-and-forget notifications
- Low-latency event distribution
- No need for message persistence

**When to use Streams:**
- Message persistence required
- At-least-once delivery needed
- Consumer group coordination
- Message replay capability
