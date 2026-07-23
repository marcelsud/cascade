# Cascade - Component Catalog

Complete documentation for all inputs, processors, outputs, and advanced features.

## Component Selection Rule

An input, output, or processor entry must contain exactly one component key. This validation is recursive, so every processor inside `branch.processors` and `switch.cases[].processors` follows the same rule.

```yaml
# Valid
input:
  http:
    port: 8080

# Invalid: both http and stdin are configured
input:
  http:
    port: 8080
  stdin: {}
```

Empty selections and multiple component keys are rejected before the pipeline is built. Conflict errors list the detected keys to make ambiguous YAML easy to correct.

## 📥 Inputs

Message sources for your pipelines:

- **[HTTP](inputs/http.md)** - Receive webhook POST requests
- **[File](inputs/file.md)** - Tail or replay newline-delimited local files
- **[Stdin](inputs/stdin.md)** - Read line-oriented or whole-stream input from standard input
- **[AWS SQS](inputs/sqs.md)** - Read from AWS SQS queues
- **[Redis Streams](inputs/redis-streams.md)** - Read from Redis Streams (simple or consumer-group mode)
- **[Redis Pub/Sub](inputs/redis-pubsub.md)** - Subscribe to Redis channels and patterns
- **[Redis Lists](inputs/redis-list.md)** - Pop from Redis Lists with blocking reads

## ⚙️ Processors

Transform and enrich messages:

- **[Metadata](processors/metadata.md)** - Add correlation IDs and timestamps for tracing
- **[Uppercase](processors/uppercase.md)** - Simple field transformation to uppercase
- **[Mapping](processors/mapping.md)** - Complex JSONata transformations and data manipulation
- **[Filter](processors/filter.md)** - Suppress messages using JSONata conditions
- **[JavaScript](processors/javascript.md)** - Sandboxed JavaScript execution (QuickJS/WASM) for imperative logic
- **[Logging](processors/logging.md)** - Log messages for debugging and monitoring

## 📤 Outputs

Destination systems for processed messages:

- **[AWS SQS](outputs/sqs.md)** - Send to SQS queues (single or batch mode)
- **[Redis Streams](outputs/redis-streams.md)** - Send to Redis Streams with length management
- **[Stdout](outputs/stdout.md)** *(alpha)* - Write each message to standard output, newline-delimited
- **[File](outputs/file.md)** *(alpha)* - Write each message to a local file, newline-delimited (append or overwrite)

## 🚀 Advanced Features

Production-ready patterns and integrations:

- **[Dead Letter Queue (DLQ)](advanced/dlq.md)** - Handle failures with automatic retries and error enrichment
- **[Backpressure Control](advanced/backpressure.md)** - Control message throughput and concurrency limits
- **[Graceful Shutdown](advanced/graceful-shutdown.md)** - Drain in-flight messages and close resources safely
- **[Bloblang Integration](advanced/bloblang.md)** - Use Benthos Bloblang syntax for migrations

## 🛠️ Development

- **[Local Development Setup](local-development.md)** - Set up LocalStack and Docker Compose for local testing
- **[Component Development Guide](COMPONENTS.md)** - Build custom inputs, processors, and outputs
- **[Component Registry](component-registry.md)** - Load custom component schemas and factories from libraries or the CLI

## Quick Links

### By Use Case

**Getting Started:**
- [SQS Input](inputs/sqs.md) → [Metadata Processor](processors/metadata.md) → [Redis Streams Output](outputs/redis-streams.md)

**Data Transformation:**
- [Mapping Processor](processors/mapping.md) - JSONata expressions
- [JavaScript Processor](processors/javascript.md) - Sandboxed imperative JS
- [Uppercase Processor](processors/uppercase.md) - Simple field transforms

**Production Patterns:**
- [DLQ](advanced/dlq.md) - Failure handling
- [Backpressure](advanced/backpressure.md) - Throughput control
- [Redis Consumer Groups](inputs/redis-streams.md#consumer-group-mode) - Distributed processing

**Debugging:**
- [Logging Processor](processors/logging.md) - Debug message flow
- [Metadata Processor](processors/metadata.md) - Add correlation IDs for tracing

### By Technology

**AWS:**
- [SQS Input](inputs/sqs.md)
- [SQS Output](outputs/sqs.md)
- [DLQ with SQS](advanced/dlq.md)

**Redis:**
- [Redis Streams Input](inputs/redis-streams.md)
- [Redis Streams Output](outputs/redis-streams.md)
- [Consumer Groups](inputs/redis-streams.md#consumer-group-mode)

**Transformations:**
- [JSONata Mapping](processors/mapping.md)
- [JavaScript](processors/javascript.md)
- [Bloblang](advanced/bloblang.md)
- [Uppercase](processors/uppercase.md)

## Documentation Structure

Each component page includes:

- **Overview** - What the component does
- **Configuration** - Required and optional fields
- **Examples** - Basic and advanced usage
- **Features** - Key capabilities
- **Use Cases** - When to use this component
- **Troubleshooting** - Common issues and solutions
- **See Also** - Related components

## Contributing

Found an issue or want to improve the docs? Please submit a PR!

- Docs are written in Markdown
- Follow the existing template structure
- Include working examples
- Cross-reference related components

## Need Help?

- Check the [main README](../README.md) for getting started
- Set up [local development](local-development.md) with LocalStack and Docker
- Review [example configurations](../configs/)
- See the [Component Development Guide](COMPONENTS.md) for building custom components
