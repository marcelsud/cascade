# Redis Streams Input

## Overview

Reads messages from Redis Streams with support for both simple direct reads and consumer group mode for distributed processing. Includes connection pooling options for production environments.

## Configuration

### Required Fields

- `url`: Redis connection URL (e.g., "redis://localhost:6379")
- `stream`: Name of the Redis Stream to read from

### Optional Fields

- `mode`: Reading mode - "simple" or "consumer-group" (default: "simple")
- `block_ms`: Blocking timeout in milliseconds (default: 5000)
- `count`: Maximum messages to retrieve per read (default: 10)
- `start_id`: Starting position - "$" (latest), "0" (beginning), or specific ID (default: "$")

### Consumer Group Mode Fields

- `consumer_group`: Name of the consumer group (required for consumer-group mode)
- `consumer_name`: Name of the consumer (optional, auto-generated if not provided)

### Connection Pooling Fields

- `connect_timeout`: Connection timeout in ms (default: 10000)
- `max_reconnect_attempts`: Retry limit after a failed Redis operation (default: unlimited)
- `reconnect_backoff_ms`: Initial reconnect delay in ms (default: 1000)
- `command_timeout`: Command timeout in ms (optional)
- `keep_alive`: TCP keep-alive in ms (default: 30000)
- `lazy_connect`: Defer connection until first command (default: false)
- `max_retries_per_request`: Max retries per request (default: 20)
- `enable_offline_queue`: Queue commands when offline (default: true)

Reconnect delays double after each failure and are capped at 30 seconds. When
`max_reconnect_attempts` is exhausted, the stream fails with a typed error and
the pipeline exits non-zero. Consumer-group initialization is retried under the
same policy; an existing `BUSYGROUP` remains a successful initialization.

## Examples

### Basic Example (Simple Mode)

```yaml
input:
  redis_streams:
    url: "redis://localhost:6379"
    stream: "events-stream"
    mode: "simple"
    block_ms: 5000
    count: 10
    start_id: "$"  # Read only new messages
```

### Consumer Group Mode (Distributed Processing)

```yaml
input:
  redis_streams:
    url: "redis://localhost:6379"
    stream: "events-stream"
    mode: "consumer-group"
    consumer_group: "my-group"
    consumer_name: "worker-1"  # Optional
    block_ms: 5000
    count: 10
```

### Production with Connection Pooling

```yaml
input:
  redis_streams:
    url: "redis://production-redis:6379"
    stream: "events-stream"
    mode: "consumer-group"
    consumer_group: "processors"

    # Connection pooling for high availability
    connect_timeout: 10000
    command_timeout: 5000
    keep_alive: 30000
    lazy_connect: false
    max_retries_per_request: 20
    enable_offline_queue: true
```

### Authenticated Redis

```yaml
input:
  redis_streams:
    url: "redis://:password@redis.example.com:6379/0"
    stream: "secure-stream"
    mode: "simple"
```

## Features

- **Simple Mode**: Direct stream reading with XREAD command
- **Consumer Group Mode**: Distributed processing with XREADGROUP
- **Automatic ACK**: Messages automatically acknowledged in consumer group mode
- **Auto-create Groups**: Consumer groups created automatically if they don't exist
- **Blocking Reads**: Efficient message waiting with configurable timeout
- **Batch Processing**: Read multiple messages at once
- **Connection Pooling**: Production-ready connection management
- **Authentication Support**: Works with password-protected Redis instances
- **Database Selection**: Supports multiple Redis databases via URL

## Use Cases

- Real-time event stream processing
- Distributed microservice communication
- Message queue with multiple consumers
- Event sourcing systems
- High-throughput data pipelines
- Reliable message delivery with consumer groups

## Reading Modes

### Simple Mode

Best for:
- Single consumer applications
- Development and testing
- Reading historical data from specific positions

Characteristics:
- Uses XREAD command
- No message ownership
- No automatic retry of failed messages
- Simpler setup

### Consumer Group Mode

Best for:
- Multiple consumers (horizontal scaling)
- Production environments
- Guaranteed message delivery
- Fault-tolerant processing

Characteristics:
- Uses XREADGROUP command
- Message ownership per consumer
- Automatic message acknowledgment
- Consumer group management
- Failed message handling

## Message Metadata

Each message includes the following metadata automatically:

- `source`: "redis-streams"
- `externalId`: Redis Stream message ID
- `receivedAt`: ISO 8601 timestamp
- `correlationId`: Auto-generated if not present

## Troubleshooting

### Consumer group errors

- Error: "NOGROUP" - Consumer group doesn't exist (auto-created on first run)
- Error: "BUSYGROUP" - Consumer group already exists (this is fine, will be used)
- Verify `consumer_group` name is correct

### Connection issues

- Check Redis is running: `redis-cli ping`
- Verify URL format: `redis://[password@]host:port[/db]`
- Increase `connect_timeout` for slow networks
- Enable `enable_offline_queue: true` for unstable connections

### No messages received

- Verify stream exists: `redis-cli XLEN stream-name`
- Check `start_id` - use "0" to read from beginning
- Ensure `block_ms` is set (enables blocking)
- For consumer groups, check no other consumer is claiming messages

### Performance issues

- Adjust `count` for batch size
- Tune `connect_timeout` and `command_timeout`
- Enable connection pooling options
- Consider multiple consumer instances with consumer groups

## See Also

- [SQS Input](sqs.md) - Alternative message input
- [Redis Streams Output](../outputs/redis-streams.md) - Send messages to Redis Streams
- [Backpressure Control](../advanced/backpressure.md) - Control message throughput
- [Metadata Processor](../processors/metadata.md) - Enrich message metadata
