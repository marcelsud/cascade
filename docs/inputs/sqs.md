# AWS SQS Input

SQS input uses at-least-once delivery. Cascade deletes a received message only
after its processors and every downstream output send succeed. A successful
DLQ send also counts as handled; output or DLQ failure leaves the message in
flight so SQS can redeliver it after the visibility timeout.

At-least-once delivery can produce duplicates, particularly when processing
succeeds but acknowledgement fails. Use the
[dedupe processor](../processors/dedupe.md) when consumers require duplicate
suppression.

Configure an SQS redrive policy with an appropriate `maxReceiveCount` as a
backstop for poison messages, including messages whose processors fail on every
delivery. Cascade's pipeline DLQ wraps output failures; it does not replace the
queue's redrive policy for persistent processor failures.

## Overview

Reads messages from AWS SQS queues with support for LocalStack. Uses long polling for efficient message retrieval and includes configurable connection settings for production environments.

## Configuration

### Required Fields

- `url`: The full SQS queue URL
- `region`: AWS region (e.g., "us-east-1")

### Optional Fields

- `endpoint`: Custom endpoint URL (useful for LocalStack) - no default
- `wait_time_seconds`: Long polling duration in seconds (default: 20)
- `max_number_of_messages`: Maximum messages to retrieve per batch (default: 10, max: 10)
- `max_attempts`: Maximum retry attempts for failed operations (default: 3)
- `request_timeout`: Request timeout in milliseconds (default: 0 = no timeout)
- `connection_timeout`: Connection timeout in milliseconds (default: 1000)

## Examples

### Basic Example (LocalStack)

```yaml
input:
  aws_sqs:
    url: "http://localhost:4566/000000000000/my-queue"
    region: "us-east-1"
    endpoint: "http://localhost:4566"
    wait_time_seconds: 20
    max_number_of_messages: 10
```

### Production Example with Connection Settings

```yaml
input:
  aws_sqs:
    url: "https://sqs.us-east-1.amazonaws.com/123456789/production-queue"
    region: "us-east-1"
    wait_time_seconds: 20
    max_number_of_messages: 10

    # Production-grade connection configuration
    max_attempts: 5
    request_timeout: 30000 # 30 seconds
    connection_timeout: 5000 # 5 seconds
```

## Features

- **Long Polling**: Reduces empty responses and costs by waiting for messages
- **Batch Processing**: Retrieve up to 10 messages at once
- **Automatic Retry**: Configurable retry logic with exponential backoff
- **LocalStack Compatible**: Perfect for local development and testing
- **Connection Pooling**: Production-ready connection settings
- **Automatic Message Deletion**: Messages are deleted after successful processing

## Use Cases

- Read from SQS queues in microservice architectures
- Process messages from AWS event-driven systems
- Local development with LocalStack
- High-throughput message processing with batching
- Reliable message consumption with automatic retries

## Message Metadata

Each message includes the following metadata automatically:

- `source`: "sqs"
- `externalId`: SQS Message ID
- `receivedAt`: ISO 8601 timestamp
- `correlationId`: Auto-generated if not present

## Troubleshooting

### Messages not appearing

- Verify the queue URL is correct
- Check that `wait_time_seconds` is set (enables long polling)
- Ensure AWS credentials are configured (for real AWS)
- For LocalStack, verify the endpoint is set correctly

### Connection timeouts

- Increase `connection_timeout` for slow networks
- Increase `request_timeout` for high-latency environments
- Check network connectivity to AWS/LocalStack

### Empty responses

- Enable long polling with `wait_time_seconds: 20`
- Verify messages exist in the queue
- Check queue visibility timeout settings

## See Also

- [Redis Streams Input](redis-streams.md) - Alternative message input
- [SQS Output](../outputs/sqs.md) - Send messages to SQS
- [Dead Letter Queue](../advanced/dlq.md) - Handle failed messages
- [Backpressure Control](../advanced/backpressure.md) - Control message throughput
