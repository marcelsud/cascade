# Redis List Output

## Overview

Pushes messages to Redis Lists using LPUSH or RPUSH commands. Provides simple, reliable queue/stack semantics with support for dynamic key routing, list length management, and retry logic. Perfect for task queues, work distribution, and buffering.

## Configuration

### Required Fields

- `url`: Redis connection URL (e.g., "redis://localhost:6379")
- `key`: List key to push to (supports template interpolation)

### Optional Fields

- `direction`: Push direction - "left" or "right" (default: "right")
  - `"left"`: LPUSH - push to the head
  - `"right"`: RPUSH - push to the tail
- `max_length`: Maximum list length (uses LTRIM to cap size)
  - `max_len` is also accepted for compatibility with earlier documentation; `max_length` takes precedence when both are set.
- `max_retries`: Number of retry attempts for failed pushes (default: 3)

### Connection Configuration Fields

- `connect_timeout`: Connection timeout in ms (default: 10000)
- `command_timeout`: Command timeout in ms (optional)
- `keep_alive`: TCP keep-alive in ms (default: 30000)
- `lazy_connect`: Defer connection until first command (default: false)
- `max_retries_per_request`: Max retries per request (default: 20)
- `enable_offline_queue`: Queue commands when offline (default: true)

## Examples

### Basic Queue (RPUSH)

```yaml
output:
  redis_list:
    url: "redis://localhost:6379"
    key: "tasks"
    direction: "right"  # Push to tail (FIFO when consumed with BLPOP)
```

### Stack (LPUSH)

```yaml
output:
  redis_list:
    url: "redis://localhost:6379"
    key: "events"
    direction: "left"  # Push to head (LIFO when consumed with BLPOP)
```

### Dynamic Key Routing

Route to different queues based on message content:

```yaml
output:
  redis_list:
    url: "redis://localhost:6379"
    key: "queue:{{content.priority}}"
    direction: "right"
```

Given a message:
```json
{
  "content": {
    "priority": "high",
    "task": "process-order"
  }
}
```

Pushes to list: `queue:high`

### Priority-Based Routing

```yaml
output:
  redis_list:
    url: "redis://localhost:6379"
    key: "tasks:{{content.urgency}}"
```

Messages automatically routed to `tasks:urgent`, `tasks:normal`, `tasks:low`, etc.

### With Length Limit

Prevent unbounded list growth:

```yaml
output:
  redis_list:
    url: "redis://localhost:6379"
    key: "recent-events"
    max_length: 1000  # Keep only last 1000 items
    direction: "right"
```

### Authenticated Redis

```yaml
output:
  redis_list:
    url: "redis://:password@redis.example.com:6379/0"
    key: "secure-queue"
```

### Production Configuration

```yaml
output:
  redis_list:
    url: "redis://production-redis:6379"
    key: "jobs:{{content.type}}"
    direction: "right"

    # Prevent unbounded growth
    max_length: 10000

    # Reliability settings
    max_retries: 5

    # Connection pooling
    connect_timeout: 10000
    command_timeout: 5000
    keep_alive: 30000
    max_retries_per_request: 20
    enable_offline_queue: true
```

## Features

- **Dynamic Key Routing**: Use template interpolation to route messages to different lists
- **FIFO/LIFO Support**: Choose LPUSH or RPUSH based on use case
- **Length Management**: Automatic LTRIM to prevent unbounded growth
- **Retry Logic**: Automatic retry with exponential backoff on failures
- **Atomic Operations**: Messages pushed atomically
- **Connection Pooling**: Optimized connection management
- **Metrics Tracking**: Built-in metrics for push success/failure rates

## Key Interpolation

Templates use `{{path.to.field}}` syntax to extract values from messages:

### Available Paths

- `{{content.field}}` - Access message content
- `{{metadata.field}}` - Access message metadata
- `{{id}}` - Message ID
- `{{correlationId}}` - Correlation ID
- `{{timestamp}}` - Message timestamp

### Examples

```yaml
# Simple field
key: "queue:{{content.type}}"

# Nested field
key: "user:{{content.user.id}}:tasks"

# Multiple fields
key: "{{content.service}}:{{content.environment}}:jobs"

# Metadata field
key: "tenant:{{metadata.tenantId}}:queue"
```

### Fallback Behavior

If a field doesn't exist, it's replaced with an empty string:
```yaml
key: "queue:{{content.missing}}"  # Becomes "queue:" if field is missing
```

## Message Format

Messages are pushed as JSON with full message structure:

```json
{
  "id": "generated-uuid",
  "correlationId": "optional-correlation-id",
  "timestamp": 1705318200000,
  "content": {
    /* your message content */
  },
  "metadata": {
    /* message metadata */
  },
  "trace": {
    /* trace context if available */
  }
}
```

## Use Cases

### Task Queue

Push tasks for background workers:
```yaml
output:
  redis_list:
    url: "redis://localhost:6379"
    key: "background-jobs"
    direction: "right"  # FIFO
```

Consumed with BLPOP for FIFO processing.

### Priority Queues

Route tasks by priority:
```yaml
output:
  redis_list:
    url: "redis://localhost:6379"
    key: "{{content.priority}}-priority-queue"
```

Separate workers can consume from `high-priority-queue`, `low-priority-queue`, etc.

### Event Buffering

Buffer events with size limit:
```yaml
output:
  redis_list:
    url: "redis://localhost:6379"
    key: "event-buffer"
    max_length: 5000  # Keep last 5000 events
    direction: "right"
```

### Work Distribution

Distribute work across multiple workers:
```yaml
output:
  redis_list:
    url: "redis://localhost:6379"
    key: "work-queue"
```

Multiple workers pop from the same queue (competing consumers).

### Per-User Queues

Create separate queues per user:
```yaml
output:
  redis_list:
    url: "redis://localhost:6379"
    key: "user:{{content.userId}}:notifications"
```

### Rate Limiting Buffer

Buffer requests with size limit:
```yaml
output:
  redis_list:
    url: "redis://localhost:6379"
    key: "api-requests"
    max_length: 100  # Max 100 pending requests
```

## FIFO vs LIFO Patterns

### FIFO Queue (Task Queue)
```yaml
# Producer (Output)
direction: "right"  # RPUSH to tail
```

```yaml
# Consumer (Input)
direction: "left"   # BLPOP from head
```

**Result**: First pushed = First consumed

### LIFO Stack (Recent Items)
```yaml
# Producer (Output)
direction: "right"  # RPUSH to tail
```

```yaml
# Consumer (Input)
direction: "right"  # BRPOP from tail
```

**Result**: Last pushed = First consumed

## List Length Management

### Without max_length

List grows indefinitely:
```yaml
output:
  redis_list:
    url: "redis://localhost:6379"
    key: "events"
```

Memory grows until Redis runs out of space.

### With max_length

List is automatically trimmed:
```yaml
output:
  redis_list:
    url: "redis://localhost:6379"
    key: "events"
    max_length: 1000
```

After each push:
1. RPUSH adds the item
2. If list length > 1000, LTRIM keeps only last 1000 items
3. Oldest items are discarded

For `direction: "left"`, LPUSH adds at the head and LTRIM keeps the first
`max_length` items instead. Both directions retain the newest entries.

**Use cases:**
- Recent event log (keep last N)
- Rate limiting (max N pending items)
- Memory-bounded buffers

## Troubleshooting

### Push Failures

For "push failed" errors:
1. **Check Connection**: Verify Redis URL and network connectivity
2. **Authentication**: Ensure password is correct if using authenticated Redis
3. **Permissions**: Verify Redis user has LPUSH/RPUSH permission
4. **Memory**: Check Redis memory usage (commands fail if memory is full)
   ```bash
   redis-cli INFO memory
   ```

### Template Interpolation Issues

If keys aren't routing correctly:
1. **Verify Field Paths**: Ensure `content.field` exists in messages
2. **Check Nesting**: Use correct dot notation for nested fields
3. **Test with Fixed Key**: Try a static key first to isolate the issue
4. **Log Message Content**: Enable debug logging to see actual message structure

### Memory Issues

If Redis runs out of memory:
1. **Add max_length**: Limit list size with LTRIM
2. **Monitor List Sizes**: Check with `redis-cli LLEN key`
3. **Configure Redis Eviction**: Set maxmemory-policy in redis.conf
4. **Increase Memory**: Allocate more RAM to Redis

### Connection Timeouts

For timeout issues:
1. Increase `connect_timeout` and `command_timeout`
2. Check network latency to Redis server
3. Monitor Redis server load and performance
4. Consider connection pooling settings

## Performance Considerations

- **Atomic Operations**: Each LPUSH/RPUSH is atomic
- **LTRIM Overhead**: max_length adds LTRIM after each push (small overhead)
- **Network Round-Trip**: Each message requires one network round-trip
- **Pipelining**: Not yet implemented; consider for high throughput
- **List Size**: Large lists (millions of items) may slow down operations
- **Connection Pooling**: Optimize settings for throughput

## Retry Behavior

Failed pushes are automatically retried with exponential backoff:

1. **First attempt**: Immediate
2. **Retry 1**: Wait 1 second
3. **Retry 2**: Wait 2 seconds
4. **Retry 3**: Wait 4 seconds
5. **Retry 4**: Wait 8 seconds

After `max_retries` failures, the message is sent to DLQ (if configured).

## Comparison with Redis Streams Output

| Feature | Lists | Streams |
|---------|-------|---------|
| Message Persistence | Until consumed | Persisted with trimming |
| Delivery Guarantee | At-most-once | At-least-once |
| Consumer Coordination | No (competing) | Yes (consumer groups) |
| Message History | No | Yes |
| Complexity | Simple | More features |
| Performance | Excellent | Very Good |

**When to use Lists:**
- Simple task queue needed
- Competing consumer pattern
- Want simplest solution
- No need for message history

**When to use Streams:**
- Need consumer groups
- Message replay required
- Want at-least-once delivery
- Need advanced features

## Redis Commands Reference

Monitor queues:
```bash
# Length of queue
LLEN tasks

# View first 10 items
LRANGE tasks 0 9

# View all items
LRANGE tasks 0 -1

# View last 5 items
LRANGE tasks -5 -1

# Manually pop an item (testing)
LPOP tasks  # Pop from head
RPOP tasks  # Pop from tail

# Trim to specific size
LTRIM tasks 0 999  # Keep only first 1000 items
```

Monitor memory:
```bash
# Total memory used by Redis
redis-cli INFO memory | grep used_memory_human

# Memory used by specific key
redis-cli MEMORY USAGE tasks
```
