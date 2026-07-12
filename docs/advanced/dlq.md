# Dead Letter Queue (DLQ)

## Overview

Send failed messages to a separate queue after exhausting retries. DLQ support helps handle failures gracefully, prevents data loss, and allows for manual intervention or reprocessing of problematic messages.

## Configuration

### Required Fields

Exactly one destination must be configured under `dlq.output`.

### Optional Fields

- `max_retries`: Number of retry attempts before sending to the DLQ (default: 3). Set it to `0` to send to the DLQ immediately after the initial failure.

DLQ retries wrap the primary output's complete `send` operation. Outputs with
their own retry behavior, such as HTTP and Redis outputs, therefore retry
internally during each DLQ-level attempt. For an HTTP output configured with
`X` retries and a DLQ configured with `Y` retries, the destination may receive
up to `(X + 1) × (Y + 1)` send attempts.

## Examples

### Basic DLQ Configuration

```yaml
output:
  aws_sqs:
    url: "http://localhost:4566/000000000000/primary-queue"

# Dead Letter Queue
dlq:
  max_retries: 3
  output:
    aws_sqs:
      url: "http://localhost:4566/000000000000/dlq-queue"
```

### DLQ with Redis Streams

```yaml
output:
  redis_streams:
    url: "redis://localhost:6379"
    stream: "processed-messages"

dlq:
  max_retries: 3
  output:
    redis_streams:
      url: "redis://localhost:6379"
      stream: "failed-messages"
```

### Custom Retry Count

```yaml
output:
  aws_sqs:
    url: "http://localhost:4566/000000000000/primary-queue"

dlq:
  max_retries: 5
  output:
    aws_sqs:
      url: "http://localhost:4566/000000000000/dlq-queue"
```

### Mixed Output Types

```yaml
# Send successfully processed messages to Redis
output:
  redis_streams:
    url: "redis://localhost:6379"
    stream: "processed"

# Send failures to SQS for inspection
dlq:
  max_retries: 3
  output:
    aws_sqs:
      url: "http://localhost:4566/000000000000/dlq-queue"
```

## Features

- **Automatic Retry**: Exponential backoff with configurable attempts
- **Comprehensive Error Details**: Full error information preserved in metadata
- **Data Loss Prevention**: Ensures no messages are lost due to transient failures
- **Manual Inspection**: Failed messages can be reviewed and debugged
- **Reprocessing**: Messages can be moved back to primary queue after fixes
- **Mixed Destinations**: DLQ can use different output type than primary output

## How It Works

1. **Initial Send**: Message is sent to primary output
2. **Failure**: If send fails, retry logic kicks in
3. **Exponential Backoff**: Retries with increasing delays (1s, 2s, 4s, 8s, ...)
4. **Max Retries Reached**: After exhausting retries, message goes to DLQ
5. **DLQ Enrichment**: Message metadata enhanced with failure details
6. **DLQ Send**: Message sent to DLQ output

## DLQ Message Metadata

When a message fails and is sent to the DLQ, it includes additional metadata:

| Field | Type | Description |
|-------|------|-------------|
| `dlq` | boolean | `true` - marks this as a DLQ message |
| `dlqReason` | string | Error message that caused the failure |
| `dlqStack` | string | Full error stack trace for debugging |
| `dlqTimestamp` | number | Unix timestamp when failure occurred |
| `dlqAttempts` | number | Total send attempts, including the initial attempt and all retries |
| `originalMessageId` | string | ID of the original message |

### Example DLQ Message

```json
{
  "content": {
    "orderId": "ORD-001",
    "amount": 100.00
  },
  "metadata": {
    "correlationId": "550e8400-e29b-41d4-a716-446655440000",
    "source": "sqs",
    "receivedAt": "2025-01-15T10:30:44.000Z",
    "dlq": true,
    "dlqReason": "Connection timeout",
    "dlqStack": "Error: Connection timeout\n  at ...",
    "dlqTimestamp": 1642248645000,
    "dlqAttempts": 4,
    "originalMessageId": "msg-original-123"
  }
}
```

## Use Cases

- **Transient Failure Handling**: Network timeouts, temporary unavailability
- **Poison Message Detection**: Messages that consistently fail processing
- **Manual Intervention**: Complex failures requiring human review
- **Debugging**: Analyze failure patterns and root causes
- **Reprocessing**: Fix issues and replay failed messages
- **Compliance**: Audit trail of failed message processing

## Retry Strategy

### Exponential Backoff

Default retry schedule uses exponential backoff:

| Attempt | Delay |
|---------|-------|
| 1 | Immediate |
| 2 | 1 second |
| 3 | 2 seconds |
| 4 | 4 seconds |
| 5 | 8 seconds |
| ... | ... |

This prevents overwhelming downstream systems while giving transient failures time to resolve.

## Best Practices

### Choosing max_retries

- **Transient failures** (network): 3-5 retries
- **Rate limits**: 5-10 retries with longer backoff
- **Quick failures**: 1-2 retries (e.g., validation errors)
- **Production**: 3-5 retries is a good default

### DLQ Monitoring

- Monitor DLQ message count (should be low in healthy systems)
- Alert on DLQ growth rate
- Review DLQ messages regularly
- Analyze `dlqReason` for patterns

### DLQ Processing

- Set up separate pipeline to process DLQ messages
- Implement alerting for DLQ arrivals
- Categorize failures (transient vs permanent)
- Create runbooks for common failure scenarios

### Reprocessing Strategy

```yaml
# DLQ reprocessing pipeline
input:
  aws_sqs:
    url: "http://localhost:4566/000000000000/dlq-queue"

pipeline:
  processors:
    # Remove DLQ metadata before reprocessing
    - mapping:
        expression: |
          {
            $: content,
            "_originalError": $meta.dlqReason
          }

output:
  aws_sqs:
    url: "http://localhost:4566/000000000000/primary-queue"
```

## Troubleshooting

### DLQ messages not appearing

- Verify DLQ output is configured correctly
- Check `dlq.max_retries` and `dlq.output`
- Ensure DLQ output connection is working
- Review logs for DLQ send errors

### Too many messages in DLQ

- Increase `dlq.max_retries` if failures are transient
- Fix underlying issue causing failures
- Check downstream system health
- Review error patterns in `dlqReason`

### DLQ send failures

- If DLQ send fails, original error is logged
- Message may be lost (last resort)
- Ensure DLQ destination is highly available
- Consider using persistent DLQ (SQS with long retention)

### Missing DLQ metadata

- Verify using latest version of library
- Check that message went through DLQ path
- Ensure no processors are removing metadata

## Integration with Monitoring

### Metrics to Track

- DLQ message count
- DLQ growth rate
- Failure categories (by dlqReason)
- Reprocessing success rate

### Alerts to Configure

- DLQ message count > threshold
- Rapid DLQ growth
- Specific error patterns
- DLQ send failures

## DLQ vs Error Handling

| Scenario | Use DLQ | Use Error Handling |
|----------|---------|-------------------|
| Network timeout | ✓ | - |
| Downstream service down | ✓ | - |
| Rate limit hit | ✓ | - |
| Invalid message format | - | ✓ (log and skip) |
| Business logic error | - | ✓ (transform and continue) |
| Validation error | - | ✓ (reject immediately) |

## See Also

- [SQS Output](../outputs/sqs.md) - Common DLQ destination
- [Redis Streams Output](../outputs/redis-streams.md) - Alternative DLQ destination
- [Backpressure Control](backpressure.md) - Prevent overwhelming systems
- [Error Categorization](../../docs/COMPONENTS.md) - Understanding error types
