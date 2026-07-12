# Backpressure Control

## Overview

Control message throughput to prevent overwhelming downstream systems, hitting rate limits, or exhausting system resources. Backpressure ensures stable, predictable performance by limiting concurrent message processing.

## Configuration

### Pipeline-Level Backpressure

Configure at the pipeline level to control overall concurrency:

```yaml
pipeline:
  backpressure:
    max_concurrent_messages: 10     # Max messages processed concurrently (default: 10)
    max_concurrent_outputs: 5       # Max concurrent output sends (default: 5)

  processors:
    - metadata:
        correlation_id_field: "correlationId"
```

### Output-Level Batching

Control throughput with batch timeouts:

```yaml
output:
  aws_sqs:
    url: "http://localhost:4566/000000000000/output-queue"
    max_batch_size: 10
    batch_timeout: 5000  # Auto-flush after 5 seconds
```

## Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `max_concurrent_messages` | positive integer | 10 | Maximum messages processed concurrently through pipeline |
| `max_concurrent_outputs` | positive integer | 5 | Maximum concurrent output send operations |

Both values are optional. When configured, zero, negative, and fractional values are rejected during configuration loading.

## Examples

### Conservative Backpressure (Low Resources)

```yaml
pipeline:
  backpressure:
    max_concurrent_messages: 5
    max_concurrent_outputs: 2

  processors:
    - mapping:
        expression: |
          { "processed": $uppercase(name) }
```

### Aggressive Throughput (High Resources)

```yaml
pipeline:
  backpressure:
    max_concurrent_messages: 50
    max_concurrent_outputs: 20

  processors:
    - uppercase:
        fields: ["name"]
```

### Balanced Configuration (Production)

```yaml
pipeline:
  backpressure:
    max_concurrent_messages: 10  # Default
    max_concurrent_outputs: 5    # Default

  processors:
    - metadata:
        correlation_id_field: "correlationId"
```

### Combined with Batch Timeout

```yaml
pipeline:
  backpressure:
    max_concurrent_messages: 20
    max_concurrent_outputs: 10

  processors:
    - mapping:
        expression: |
          { "transformed": data }

output:
  aws_sqs:
    url: "http://localhost:4566/000000000000/output-queue"
    max_batch_size: 10
    batch_timeout: 3000  # Flush every 3 seconds
```

## How It Works

### Message Processing Concurrency

1. Input reads messages from source
2. Messages enter pipeline processing queue
3. Maximum `max_concurrent_messages` processed simultaneously
4. When limit reached, input blocks until slots available
5. This creates backpressure upstream

### Output Concurrency

1. Processed messages ready for output
2. Maximum `max_concurrent_outputs` sent simultaneously
3. When limit reached, processor blocks until slots available
4. This creates backpressure in processing stage

### Flow Control

```
Input → [Queue] → Processing (max_concurrent_messages) → [Queue] → Output (max_concurrent_outputs) → Destination
         ↑                                                  ↑
         └── Blocks when full                              └── Blocks when full
```

## Use Cases

- **Rate Limit Protection**: Prevent hitting API rate limits
- **Resource Management**: Control memory and CPU usage
- **Downstream Protection**: Prevent overwhelming target systems
- **Stable Throughput**: Predictable, sustainable message processing
- **Cost Control**: Limit cloud resource consumption
- **Graceful Degradation**: Handle traffic spikes smoothly

## Tuning Guidelines

### Determining max_concurrent_messages

Consider:
- **Available Memory**: Each concurrent message consumes memory
- **Processing Complexity**: Complex transformations = lower concurrency
- **CPU Cores**: General guideline: 2-5x number of cores
- **Network I/O**: I/O-bound workloads can handle higher concurrency

**Example Calculations:**

| System | CPU Cores | Memory | Workload | Recommended |
|--------|-----------|--------|----------|-------------|
| Small | 2 | 4GB | Simple | 5-10 |
| Medium | 4 | 8GB | Moderate | 10-20 |
| Large | 8+ | 16GB+ | Complex | 20-50 |

### Determining max_concurrent_outputs

Consider:
- **Output Type**: Network I/O vs local writes
- **Downstream Capacity**: Target system limits
- **Batch Size**: Larger batches = lower concurrency needed
- **Network Bandwidth**: Available throughput

**Typical Values:**
- **SQS/Network Outputs**: 5-10
- **Redis Streams**: 10-20
- **File Outputs**: 2-5
- **HTTP APIs**: 5-15 (check rate limits)

## Benefits

### Memory Stability

```yaml
# Without backpressure: Memory can grow unbounded
# Fast input + slow output = memory leak

# With backpressure: Memory bounded
pipeline:
  backpressure:
    max_concurrent_messages: 10  # Max 10 messages in memory
```

### Predictable Performance

```yaml
# Stable throughput: ~100 messages/sec
pipeline:
  backpressure:
    max_concurrent_messages: 10
    max_concurrent_outputs: 5

  # vs

# Variable throughput: 50-500 messages/sec (unstable)
pipeline:
  backpressure:
    max_concurrent_messages: 100  # Too high
    max_concurrent_outputs: 50
```

### Rate Limit Respect

```yaml
# API rate limit: 100 requests/sec
# Each output send = 1 request
# Target: 10 batches/sec * 10 msgs/batch = 100 msg/sec

output:
  aws_sqs:
    max_batch_size: 10
    batch_timeout: 100  # 10 batches/sec = 100 requests/sec

pipeline:
  backpressure:
    max_concurrent_outputs: 2  # Limit concurrent requests
```

## Performance Impact

### Throughput Trade-offs

| Configuration | Throughput | Stability | Resource Usage |
|---------------|------------|-----------|----------------|
| High concurrency (50/20) | High | Low | High |
| Medium concurrency (10/5) | Medium | High | Medium |
| Low concurrency (5/2) | Low | Very High | Low |

### Latency Considerations

- **Higher concurrency**: Lower per-message latency (parallel processing)
- **Lower concurrency**: Higher per-message latency (sequential processing)
- **Batch timeouts**: Add latency but improve throughput

## Monitoring

### Key Metrics

- **Messages in pipeline**: Should stay near `max_concurrent_messages`
- **Output queue depth**: Should stay near `max_concurrent_outputs`
- **Blocked time**: Time spent waiting for slots
- **Memory usage**: Should be stable
- **CPU usage**: Should match concurrency settings

### Tuning Signals

**Increase concurrency if:**
- CPU < 70% utilized
- Memory has headroom
- Output queue often empty
- Throughput below requirements

**Decrease concurrency if:**
- Memory usage growing
- CPU > 90% sustained
- Downstream errors increasing
- System instability

## Best Practices

### Start Conservative

```yaml
# Begin with defaults
pipeline:
  backpressure:
    max_concurrent_messages: 10
    max_concurrent_outputs: 5
```

### Monitor and Adjust

1. Deploy with conservative settings
2. Monitor metrics (CPU, memory, throughput)
3. Gradually increase concurrency
4. Stop when metrics degrade

### Match Downstream Capacity

```yaml
# If downstream can handle 100 req/sec
# And each send = 1 request
# Use: max_concurrent_outputs: 5-10
# With batch_timeout: 100-200ms
```

### Environment-Specific Settings

```yaml
# Development
pipeline:
  backpressure:
    max_concurrent_messages: 5
    max_concurrent_outputs: 2

# Production
pipeline:
  backpressure:
    max_concurrent_messages: 20
    max_concurrent_outputs: 10
```

## Troubleshooting

### Low Throughput

**Symptoms**: Messages processed slowly, system underutilized

**Solutions**:
- Increase `max_concurrent_messages`
- Increase `max_concurrent_outputs`
- Reduce `batch_timeout` (faster flushes)
- Check for bottlenecks in processors

### High Memory Usage

**Symptoms**: Memory growing, OOM errors

**Solutions**:
- Decrease `max_concurrent_messages`
- Check for memory leaks in processors
- Reduce message size
- Monitor per-message memory usage

### Output Errors

**Symptoms**: Downstream system errors, timeouts

**Solutions**:
- Decrease `max_concurrent_outputs`
- Increase `batch_timeout` (slower sends)
- Check downstream capacity
- Implement rate limiting

### Uneven Processing

**Symptoms**: Bursts of activity, then idle

**Solutions**:
- Adjust `batch_timeout` to smooth out sends
- Check input source for uneven production
- Consider buffering at input level

## Integration with Other Features

### With DLQ

```yaml
pipeline:
  backpressure:
    max_concurrent_messages: 10
    max_concurrent_outputs: 5

output:
  aws_sqs:
    url: "..."
    max_retries: 3  # Retry before DLQ

dlq:
  aws_sqs:
    url: "..."  # Failed messages after retries
```

### With Batch Timeout

```yaml
pipeline:
  backpressure:
    max_concurrent_messages: 20
    max_concurrent_outputs: 10

output:
  aws_sqs:
    max_batch_size: 10
    batch_timeout: 5000  # Flush after 5 sec
```

## See Also

- [Dead Letter Queue](dlq.md) - Handle failed messages
- [SQS Output](../outputs/sqs.md) - Batch timeout configuration
- [Redis Streams Input](../inputs/redis-streams.md) - Consumer group for distributed backpressure
