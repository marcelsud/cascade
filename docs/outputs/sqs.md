# AWS SQS Output

## Overview

Sends messages to AWS SQS queues with support for both single-message and batch modes. Includes automatic batch management with configurable timeouts and LocalStack compatibility for local development.

## Configuration

### Required Fields

- `url`: The full SQS queue URL
- `region`: AWS region (e.g., "us-east-1")

### Optional Fields

- `endpoint`: Custom endpoint URL (useful for LocalStack) - no default
- `max_batch_size`: Messages per batch - 1 for single sends, 2-10 for batching (default: 1)
- `batch_timeout`: Auto-flush timeout in milliseconds (optional, requires max_batch_size > 1)
- `delay_seconds`: Delay message delivery (0-900 seconds, default: 0)
- `max_retries`: Maximum retry attempts for failures (inherited from parent config)

## Examples

### Basic Example (Single Message Mode)

```yaml
output:
  aws_sqs:
    url: "http://localhost:4566/000000000000/output-queue"
    region: "us-east-1"
    endpoint: "http://localhost:4566"
    max_batch_size: 1  # Send immediately
```

### Batch Mode (High Throughput)

```yaml
output:
  aws_sqs:
    url: "http://localhost:4566/000000000000/output-queue"
    region: "us-east-1"
    endpoint: "http://localhost:4566"
    max_batch_size: 10        # Accumulate up to 10 messages
    batch_timeout: 5000       # Auto-flush after 5 seconds
```

### Production Example

```yaml
output:
  aws_sqs:
    url: "https://sqs.us-east-1.amazonaws.com/123456789/production-queue"
    region: "us-east-1"
    max_batch_size: 10
    batch_timeout: 3000       # 3 second auto-flush
    delay_seconds: 0
```

### Delayed Delivery

```yaml
output:
  aws_sqs:
    url: "https://sqs.us-east-1.amazonaws.com/123456789/delayed-queue"
    region: "us-east-1"
    max_batch_size: 1
    delay_seconds: 300        # Deliver after 5 minutes
```

## Features

- **Single Message Mode**: Immediate sends with max_batch_size: 1
- **Batch Mode**: Efficient bulk sending with max_batch_size: 2-10
- **Automatic Batch Flush**: Time-based flush with batch_timeout
- **Metadata Preservation**: Message metadata stored as SQS message attributes
- **Delayed Delivery**: Schedule message delivery up to 15 minutes in future
- **Partial Batch Failure Handling**: Retries failed messages in batches
- Successful batch entries are never resent when SQS reports partial failure
- **LocalStack Compatible**: Perfect for local development
- **Automatic Retry**: Configurable retry logic with exponential backoff

## Sending Modes

### Single Message Mode (max_batch_size: 1)

**Best for:**
- Low-latency requirements
- Low message volume
- Real-time processing
- Simple use cases

**Characteristics:**
- Each message sent immediately
- No batching overhead
- Higher API call costs (AWS charges per request)
- Lower throughput

### Batch Mode (max_batch_size: 2-10)

**Best for:**
- High message volume
- Cost optimization
- High throughput pipelines
- Bulk processing

**Characteristics:**
- Accumulates messages before sending
- Sends when batch is full OR timeout expires
- Reduced API calls (lower AWS costs)
- Higher throughput
- Slight latency trade-off

## Batch Timeout Behavior

When `batch_timeout` is configured:

1. Messages accumulate in a batch
2. Batch sends when:
   - Batch reaches `max_batch_size`, OR
   - `batch_timeout` milliseconds elapse since first message
3. Auto-flush on pipeline shutdown

**Example Timeline:**
```
T+0ms:    Message 1 arrives → Start timer
T+100ms:  Message 2 arrives → Batch size: 2
T+200ms:  Message 3 arrives → Batch size: 3
T+5000ms: Timeout expires → Send batch (3 messages)
```

## Message Format

Messages are serialized to JSON and sent with metadata as SQS message attributes:

**SQS Message Attributes:**
- `correlationId`: String
- `source`: String (e.g., "redis-streams", "sqs")
- `receivedAt`: String (ISO 8601)
- `processedAt`: String (ISO 8601)

## Use Cases

- Asynchronous task queuing
- Event-driven architecture
- Microservice communication
- Decoupling services
- Buffer for downstream processing
- Fan-out messaging patterns
- Delayed job execution
- Load leveling

## Performance Considerations

### Throughput

- **Single mode**: ~300 messages/sec per instance
- **Batch mode (10)**: ~3000 messages/sec per instance
- Scale horizontally for higher throughput

### Cost Optimization

- Batching reduces API requests by up to 10x
- Fewer API requests = lower AWS costs
- Use `batch_timeout` to balance latency and cost

### Latency

- **Single mode**: <10ms send latency
- **Batch mode**: Up to `batch_timeout` additional latency
- Choose batch_timeout based on your SLA

## Best Practices

### For High Throughput
- Use `max_batch_size: 10`
- Set `batch_timeout: 1000-5000` ms
- Monitor batch fill rate
- Scale horizontally if needed

### For Low Latency
- Use `max_batch_size: 1`
- No batch_timeout needed
- Accept higher costs

### For Cost Optimization
- Use `max_batch_size: 10`
- Set `batch_timeout: 5000-10000` ms
- Monitor AWS costs in CloudWatch

### For Production
- Set appropriate `max_retries` (3-5)
- Configure [Dead Letter Queue](../advanced/dlq.md)
- Monitor SQS metrics (ApproximateNumberOfMessages, etc.)
- Use IAM roles instead of access keys

## Partial Batch Failures

When sending batches, SQS may accept some messages and reject others:

1. Successful messages are confirmed
2. Failed messages are retried automatically
3. After max_retries, failed messages go to DLQ (if configured)
4. Partial success is logged for troubleshooting

## Troubleshooting

### Messages not appearing in queue

- Verify queue URL is correct
- Check AWS credentials/IAM permissions
- Ensure region matches queue region
- For LocalStack, verify endpoint is set
- Check SQS queue exists

### Batch timeout not working

- Verify `max_batch_size > 1`
- Ensure `batch_timeout` is set
- Check message volume (need at least 1 message to trigger timeout)
- Review logs for batch flush events

### High latency

- Reduce `batch_timeout`
- Use `max_batch_size: 1` for immediate sends
- Check network latency to AWS
- Monitor SQS queue metrics

### Partial batch failures

- Check CloudWatch Logs for error details
- Verify message size < 256KB
- Ensure message attributes are valid
- Review IAM permissions
- Configure DLQ for permanent failures

### Cost concerns

- Increase `max_batch_size` to reduce requests
- Use `batch_timeout` to batch more messages
- Monitor AWS Cost Explorer
- Consider SQS FIFO queues for deduplication

## AWS SQS Limits

- **Message size**: 256 KB maximum
- **Batch size**: 10 messages maximum (SQS limit)
- **Delay**: 0-900 seconds (15 minutes)
- **Retention**: 1 minute to 14 days (queue setting)
- **Message attributes**: 10 attributes per message

## Monitoring

### Key Metrics
- Messages sent per second
- Batch fill rate
- API request count
- Failed messages
- DLQ message count

### CloudWatch Metrics
- `NumberOfMessagesSent`
- `NumberOfMessagesReceived`
- `ApproximateAgeOfOldestMessage`
- `ApproximateNumberOfMessages`

## See Also

- [SQS Input](../inputs/sqs.md) - Read from SQS queues
- [Redis Streams Output](redis-streams.md) - Alternative output
- [Dead Letter Queue](../advanced/dlq.md) - Handle failed outputs
- [Backpressure Control](../advanced/backpressure.md) - Control output throughput
