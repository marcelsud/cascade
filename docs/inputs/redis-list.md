# Redis List Input

## Overview

Consumes messages from Redis Lists using blocking pop operations (BLPOP/BRPOP). Provides simple, reliable FIFO/LIFO queue behavior with support for multiple list keys and configurable timeouts. Perfect for task queues and work distribution.

## Configuration

### Required Fields

- `url`: Redis connection URL (e.g., "redis://localhost:6379")
- `key`: List key to pop from (string or array of strings)

### Optional Fields

- `direction`: Pop direction - "left" or "right" (default: "left")
  - `"left"`: BLPOP - pop from the head (FIFO behavior)
  - `"right"`: BRPOP - pop from the tail (LIFO behavior)
- `timeout`: Blocking timeout in seconds (default: 5)

### Connection Configuration Fields

- `connect_timeout`: Connection timeout in ms (default: 10000)
- `max_reconnect_attempts`: Retry limit after a failed Redis operation (default: unlimited)
- `reconnect_backoff_ms`: Initial reconnect delay in ms (default: 1000)
- `command_timeout`: Command timeout in ms (optional)
- `keep_alive`: TCP keep-alive in ms (default: 30000)
- `lazy_connect`: Defer connection until first command (default: false)
- `max_retries_per_request`: Max retries per request (default: 20)
- `enable_offline_queue`: Queue commands when offline (default: true)

Reconnect delays double after each failure and are capped at 30 seconds. When
`max_reconnect_attempts` is exhausted, the input stream fails with a typed error
and the pipeline exits non-zero. Omit it to preserve unlimited reconnects.
The end-to-end suite also verifies bounded retries against an unreachable Redis.

## Examples

### Basic FIFO Queue (BLPOP)

```yaml
input:
  redis_list:
    url: "redis://localhost:6379"
    key: "tasks"
    direction: "left"  # Pop from head (FIFO)
    timeout: 5
```

### LIFO Stack (BRPOP)

```yaml
input:
  redis_list:
    url: "redis://localhost:6379"
    key: "tasks"
    direction: "right"  # Pop from tail (LIFO)
```

### Multiple Priority Queues

```yaml
input:
  redis_list:
    url: "redis://localhost:6379"
    key:
      - "high-priority"
      - "medium-priority"
      - "low-priority"
    direction: "left"
    timeout: 10
```

**Behavior**: Checks lists in order, pops from the first non-empty list. This provides priority queue semantics.

### Long Polling

```yaml
input:
  redis_list:
    url: "redis://localhost:6379"
    key: "events"
    timeout: 30  # Wait up to 30 seconds for new items
```

### Authenticated Redis

```yaml
input:
  redis_list:
    url: "redis://:password@redis.example.com:6379/0"
    key: "secure-queue"
```

### Production Configuration

```yaml
input:
  redis_list:
    url: "redis://production-redis:6379"
    key:
      - "critical-tasks"
      - "normal-tasks"

    # Reasonable timeout for production
    timeout: 10

    # High availability settings
    connect_timeout: 10000
    command_timeout: 5000
    keep_alive: 30000
    max_retries_per_request: 20
    enable_offline_queue: true
```

## Features

- **Blocking Operations**: Efficient waiting with BLPOP/BRPOP (no busy polling)
- **Multiple Keys**: Check multiple lists in priority order
- **FIFO/LIFO**: Choose direction based on use case
- **Timeout Control**: Configurable blocking timeout prevents indefinite waits
- **Atomic Operations**: Messages popped atomically (guaranteed single consumer)
- **Reliable**: Messages are consumed exactly once
- **Simple**: Straightforward queue semantics without consumer groups

## Message Format

Messages popped from Redis Lists are automatically parsed as JSON:

```javascript
{
  "id": "generated-uuid",
  "content": { /* parsed JSON from Redis */ },
  "metadata": {
    "source": "redis-list-input",
    "listKey": "tasks",  // Which list the message came from
    "receivedAt": "2024-01-15T10:30:00.000Z"
  },
  "timestamp": 1705318200000
}
```

If JSON parsing fails, the raw value is wrapped:
```javascript
{
  "content": {
    "raw": "original-non-json-value"
  }
}
```

## Use Cases

### Task Queue (FIFO)

Process tasks in order:
```yaml
input:
  redis_list:
    url: "redis://localhost:6379"
    key: "background-jobs"
    direction: "left"  # FIFO
```

Push tasks with:
```bash
redis-cli RPUSH background-jobs '{"type": "send-email", "to": "user@example.com"}'
```

### Stack (LIFO)

Process most recent items first:
```yaml
input:
  redis_list:
    url: "redis://localhost:6379"
    key: "recent-events"
    direction: "right"  # LIFO
```

### Priority Queue

Process by priority:
```yaml
input:
  redis_list:
    url: "redis://localhost:6379"
    key:
      - "urgent"
      - "high"
      - "normal"
      - "low"
```

Push to appropriate queue:
```bash
redis-cli RPUSH urgent '{"task": "critical-fix"}'
redis-cli RPUSH normal '{"task": "regular-work"}'
```

### Work Distribution

Multiple workers consuming from the same queue:
```yaml
# Worker 1
input:
  redis_list:
    url: "redis://localhost:6379"
    key: "shared-queue"
```

```yaml
# Worker 2
input:
  redis_list:
    url: "redis://localhost:6379"
    key: "shared-queue"
```

Each worker atomically pops different messages.

## FIFO vs LIFO Patterns

### FIFO (First In, First Out)
```yaml
direction: "left"  # BLPOP
```

**Producer adds to tail:**
```bash
RPUSH queue "item1"
RPUSH queue "item2"
```

**Consumer pops from head:**
- First pop gets "item1"
- Second pop gets "item2"

**Use when:** Task ordering matters, process oldest first

### LIFO (Last In, First Out)
```yaml
direction: "right"  # BRPOP
```

**Producer adds to tail:**
```bash
RPUSH queue "item1"
RPUSH queue "item2"
```

**Consumer pops from tail:**
- First pop gets "item2"
- Second pop gets "item1"

**Use when:** Process most recent items first, stack behavior needed

## Troubleshooting

### No Messages Received

1. **Check List Contents**: Verify items exist in the list
   ```bash
   redis-cli LLEN tasks
   redis-cli LRANGE tasks 0 -1
   ```

2. **Verify Key Name**: Ensure key matches exactly (case-sensitive)
   ```bash
   redis-cli KEYS 'task*'
   ```

3. **Check Connection**: Test Redis connectivity
   ```bash
   redis-cli -h localhost -p 6379 PING
   ```

4. **Timeout Settings**: Increase timeout if network is slow
   ```yaml
   timeout: 30  # Wait longer
   ```

### Timeout Warnings

If timeouts occur frequently:
- Normal behavior when queue is empty
- Adjust `timeout` based on expected message frequency
- Consider using Redis Streams for persistent message storage

### Connection Issues

For connection problems:
1. Verify Redis URL and credentials
2. Check firewall rules and network connectivity
3. Increase `connect_timeout` if needed
4. Enable `enable_offline_queue` for reconnection resilience

### Multiple Keys Not Working

When using multiple keys:
- BLPOP checks keys in order specified
- Pops from FIRST non-empty list
- All keys must be accessible by the same Redis connection
- Cannot span multiple Redis databases

## Performance Considerations

- **Blocking is Efficient**: BLPOP/BRPOP use server-side blocking (no CPU waste)
- **Timeout Impact**: Short timeouts = more frequent Redis calls; balance with use case
- **Multiple Keys Overhead**: Checking many keys slightly slower than single key
- **Atomic Operations**: Each pop is atomic, safe for multiple consumers
- **Network Round-Trip**: Each message requires one network round-trip
- **Connection Pooling**: Connection settings optimize throughput

## Comparison with Redis Streams

| Feature | Lists | Streams |
|---------|-------|---------|
| Message Persistence | Until consumed | Persisted with trimming |
| Consumer Groups | No | Yes |
| Acknowledgment | Automatic (on pop) | Manual (XACK) |
| Multiple Consumers | Yes (competing) | Yes (groups) |
| Message History | No | Yes |
| Complexity | Simple | More features |
| Performance | Excellent | Very Good |

**When to use Lists:**
- Simple task queue needed
- Competing consumer pattern
- No need for message history
- Want simplest solution

**When to use Streams:**
- Need consumer groups
- Message replay required
- Want message persistence
- Need at-least-once delivery guarantees

## Redis Commands Reference

Producer commands to add items:
```bash
# Add to tail (use with BLPOP for FIFO)
RPUSH queue "message"

# Add to head (use with BRPOP for LIFO)
LPUSH queue "message"

# Add multiple items
RPUSH queue "msg1" "msg2" "msg3"

# Check queue length
LLEN queue

# View items without removing
LRANGE queue 0 -1
```

Monitor queues:
```bash
# Length of queue
LLEN tasks

# View first 10 items
LRANGE tasks 0 9

# View all items
LRANGE tasks 0 -1
```
