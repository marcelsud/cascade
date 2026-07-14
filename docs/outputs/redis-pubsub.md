# Redis Pub/Sub Output

## Overview

Publishes messages to Redis Pub/Sub channels for real-time event broadcasting. Supports channel name interpolation for dynamic routing based on message content. Includes retry logic and connection pooling for production reliability.

## Configuration

### Required Fields

- `url`: Redis connection URL (e.g., "redis://localhost:6379")
- `channel`: Channel name to publish to (supports template interpolation)

### Optional Fields

- `max_retries`: Number of retry attempts for failed publishes (default: 3)

### Connection Configuration Fields

- `connect_timeout`: Connection timeout in ms (default: 10000)
- `command_timeout`: Command timeout in ms (optional)
- `keep_alive`: TCP keep-alive in ms (default: 30000)
- `lazy_connect`: Defer connection until first command (default: false)
- `max_retries_per_request`: Max retries per request (default: 20)
- `enable_offline_queue`: Queue commands when offline (default: false)

Redis outputs fail fast by default while disconnected, allowing Cascade retry
and DLQ policies to handle the message. Set this to `true` only when replaying
commands queued during an outage is explicitly acceptable.

## Examples

### Basic Publishing

```yaml
output:
  redis_pubsub:
    url: "redis://localhost:6379"
    channel: "events"
```

### Dynamic Channel Routing (Template Interpolation)

Route messages to different channels based on content:

```yaml
output:
  redis_pubsub:
    url: "redis://localhost:6379"
    channel: "events:{{content.type}}"
```

Given a message:
```json
{
  "content": {
    "type": "user_login",
    "userId": "123"
  }
}
```

Publishes to channel: `events:user_login`

### Multi-Level Routing

```yaml
output:
  redis_pubsub:
    url: "redis://localhost:6379"
    channel: "{{content.service}}:{{content.level}}"
```

Given:
```json
{
  "content": {
    "service": "auth",
    "level": "error",
    "message": "Login failed"
  }
}
```

Publishes to: `auth:error`

### Metadata-Based Routing

```yaml
output:
  redis_pubsub:
    url: "redis://localhost:6379"
    channel: "tenant:{{metadata.tenantId}}:events"
```

### With Retry Configuration

```yaml
output:
  redis_pubsub:
    url: "redis://localhost:6379"
    channel: "events"
    max_retries: 5  # Retry up to 5 times
```

### Authenticated Redis

```yaml
output:
  redis_pubsub:
    url: "redis://:password@redis.example.com:6379/0"
    channel: "secure-events"
```

### Production Configuration

```yaml
output:
  redis_pubsub:
    url: "redis://production-redis:6379"
    channel: "prod-events:{{content.type}}"

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

- **Dynamic Channel Routing**: Use template interpolation to route messages based on content
- **Retry Logic**: Automatic retry with exponential backoff on publish failures
- **Subscriber Tracking**: Logs warning if no subscribers received the message
- **Connection Pooling**: Optimized connection management for high throughput
- **Atomic Publishing**: Messages are published atomically with PUBLISH command
- **Metrics Tracking**: Built-in metrics for publish success/failure rates

## Channel Interpolation

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
channel: "events:{{content.type}}"

# Nested field
channel: "user:{{content.user.id}}:notifications"

# Multiple fields
channel: "{{content.service}}:{{content.environment}}:logs"

# Metadata field
channel: "tenant:{{metadata.tenantId}}:events"
```

### Fallback Behavior

If a field doesn't exist, it's replaced with an empty string:
```yaml
channel: "events:{{content.missing}}"  # Becomes "events:" if field is missing
```

## Message Format

Messages are published as JSON with full message structure preserved:

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

### Event Broadcasting
Broadcast application events to subscribers:
```yaml
output:
  redis_pubsub:
    url: "redis://localhost:6379"
    channel: "app-events"
```

### Type-Based Routing
Route different event types to different channels:
```yaml
output:
  redis_pubsub:
    url: "redis://localhost:6379"
    channel: "events:{{content.eventType}}"
```

### Multi-Tenant Events
Publish tenant-specific events:
```yaml
output:
  redis_pubsub:
    url: "redis://localhost:6379"
    channel: "tenant:{{content.tenantId}}:events"
```

### Service-to-Service Notifications
Notify other microservices of events:
```yaml
output:
  redis_pubsub:
    url: "redis://localhost:6379"
    channel: "service:{{content.targetService}}:notifications"
```

### Log Level Routing
Route logs by severity:
```yaml
output:
  redis_pubsub:
    url: "redis://localhost:6379"
    channel: "logs:{{content.level}}"
```

## Troubleshooting

### No Subscribers Warning

If you see "no subscribers were listening" warnings:
- This is informational - messages are successfully published
- Messages published without subscribers are lost (Pub/Sub nature)
- Ensure subscribers are connected before publishing
- Consider using Redis Streams if message persistence is needed

### Publish Failures

For "publish failed" errors:
1. **Check Connection**: Verify Redis URL and network connectivity
2. **Authentication**: Ensure password is correct if using authenticated Redis
3. **Permissions**: Verify Redis user has PUBLISH permission
4. **Memory**: Check Redis memory usage (PUBLISH can fail if memory is full)

### Template Interpolation Issues

If channels aren't routing correctly:
1. **Verify Field Paths**: Ensure `content.field` or `metadata.field` exists in messages
2. **Check Nesting**: Use correct dot notation for nested fields
3. **Test with Fixed Channel**: Try a static channel first to isolate the issue
4. **Log Message Content**: Enable debug logging to see actual message structure

### Connection Timeouts

For timeout issues:
1. Increase `connect_timeout` and `command_timeout`
2. Check network latency to Redis server
3. Monitor Redis server load and performance
4. Consider connection pooling settings

## Performance Considerations

- **Fire-and-Forget**: PUBLISH doesn't wait for subscribers to process messages
- **Return Value**: PUBLISH returns number of subscribers who received the message
- **Network Overhead**: Each PUBLISH is a separate network round-trip
- **Batching**: For high throughput, consider using pipelines (not yet implemented)
- **Channel Count**: Fewer channels = better performance; avoid creating channels per message
- **Message Size**: Large messages slow down publishing; consider compression

## Retry Behavior

Failed publishes are automatically retried with exponential backoff:

1. **First attempt**: Immediate
2. **Retry 1**: Wait 1 second
3. **Retry 2**: Wait 2 seconds
4. **Retry 3**: Wait 4 seconds
5. **Retry 4**: Wait 8 seconds

After `max_retries` failures, the message is sent to DLQ (if configured).

## Comparison with Redis Streams Output

| Feature | Pub/Sub | Streams |
|---------|---------|---------|
| Message Persistence | No | Yes |
| Delivery Guarantee | At-most-once | At-least-once |
| Subscriber Count | PUBLISH returns count | Not available |
| History | No | Yes (with trimming) |
| Performance | Faster | Good |
| Use Case | Real-time broadcasting | Reliable messaging |

**When to use Pub/Sub:**
- Real-time event broadcasting
- Fire-and-forget semantics acceptable
- Low-latency event distribution
- No need for message persistence

**When to use Streams:**
- Message persistence required
- At-least-once delivery needed
- Consumer acknowledgment required
- Message replay capability
