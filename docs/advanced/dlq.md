# Dead Letter Queue (DLQ)

The Docker-backed end-to-end suite verifies that a failed Redis Streams
destination is rerouted to SQS with failure metadata and separate DLQ metrics.

## Overview

Send failed messages to a separate queue after category-aware primary handling. DLQ support helps handle failures gracefully, prevents data loss, and allows for manual intervention or reprocessing of problematic messages.

## Configuration

### Required Fields

Exactly one destination must be configured under `dlq.output`.

### Optional Fields

- `max_retries`: Number of retry attempts for intermittent failures before sending to the DLQ (default: 3). Set it to `0` to send to the DLQ immediately after the initial failure.
- `retry_schedule`: `exponential`, `fixed`, or `linear` (default: `exponential`)
- `retry_interval_ms`: Positive base interval in milliseconds (default: `1000`)

After the previous attempt completes, an exponential schedule delays the next
retry by `1×`, `2×`, `4×`, and so on. A linear schedule delays by `1×`, `2×`,
`3×`, and so on. A fixed schedule waits the configured interval after each
attempt completes.

Retry eligibility follows the error category:

- `intermittent`: retry up to `max_retries`, then send to the DLQ.
- `logical`: skip retries and send to the DLQ after the initial failure.
- `fatal`: skip retries, copy to the DLQ when configured, and keep the
  original failure fatal so the pipeline stops intake.

Errors without an explicit category use Cascade's existing category detection.

DLQ retries wrap the primary output's complete `send` operation. Outputs with
their own retry behavior, such as HTTP and Redis outputs, therefore retry
internally during each DLQ-level attempt. When the final output failure is
intermittent, an HTTP output configured with `X` retries and a DLQ configured
with `Y` retries may make up to `(X + 1) × (Y + 1)` destination attempts.

Terminal processor-chain failures bypass the primary output and are copied
directly to the configured DLQ once, after any retry behavior owned by that
processor has finished. `dlq.max_retries` applies only to primary output sends;
it does not re-run processors. The failed input remains failed for pipeline
accounting and is not acknowledged, even when the DLQ copy succeeds.

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
  retry_schedule: linear
  retry_interval_ms: 500
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

- **Category-Aware Retry**: Configurable backoff for intermittent failures; logical and fatal failures skip retries
- **Comprehensive Error Details**: Full error information preserved in metadata
- **Data Loss Prevention**: Ensures no messages are lost due to transient failures
- **Manual Inspection**: Failed messages can be reviewed and debugged
- **Reprocessing**: Messages can be moved back to primary queue after fixes
- **Mixed Destinations**: DLQ can use different output type than primary output

## How It Works

1. **Processing**: Processors transform the input message
2. **Processor Failure**: A terminal processor-chain failure skips the primary output and acknowledgement, then sends one enriched copy directly to the DLQ
3. **Initial Output Send**: A successfully processed message is sent to the primary output
4. **Classification**: An output failure is classified as intermittent, logical, or fatal
5. **Eligible Output Retry**: Only intermittent output failures use the configured DLQ retry schedule
6. **DLQ Enrichment**: Failure metadata records the applicable operation attempt count
7. **DLQ Send**: The failed message is sent to the configured DLQ output
8. **Resolution**: Logical and exhausted intermittent output failures resolve after a successful DLQ copy; processor failures remain failed in pipeline accounting
9. **Fatal Halt**: Fatal failures remain failed after the DLQ copy, stopping pipeline intake

## DLQ Message Metadata

When a message fails and is sent to the DLQ, it includes additional metadata:

| Field | Type | Description |
|-------|------|-------------|
| `dlq` | boolean | `true` - marks this as a DLQ message |
| `dlqReason` | string | Error message that caused the failure |
| `dlqStack` | string | Full error stack trace for debugging |
| `dlqTimestamp` | number | Unix timestamp when failure occurred |
| `dlqAttempts` | number | Operation attempt count: `1` for processor-chain failures, or total primary output send attempts including retries |
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
