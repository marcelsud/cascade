# HTTP Input

## Overview

Receives HTTP POST requests as a webhook server. Each incoming request is converted into a pipeline message and processed through your configured processors and output. Perfect for receiving webhooks from external services, building API gateways, or creating event receivers.

## Configuration

### Required Fields

- `port`: Port number to listen on (e.g., 8080)

### Optional Fields

- `host`: Host address to bind to (default: "0.0.0.0")
- `path`: URL path to listen on (default: "/webhook")
- `timeout`: Request timeout in milliseconds (default: 30000)
- `queue_size`: Maximum messages buffered in memory (default: `1000`)
- `overflow`: `block`, `drop_new`, or `drop_old` (default: `block`)

`block` keeps the request open until queue capacity is available and provides
backpressure to webhook senders. The two drop policies respond normally but
increment `messagesDropped`; overflow warnings are rate-limited.

## Examples

### Basic Webhook Server

```yaml
input:
  http:
    port: 8080
    path: "/webhook"
```

### Custom Host and Path

```yaml
input:
  http:
    port: 3000
    host: "localhost"
    path: "/events"
    timeout: 60000  # 60 seconds
```

### Production Webhook Receiver

```yaml
input:
  http:
    port: 8080
    host: "0.0.0.0"
    path: "/api/webhooks"
    timeout: 30000

pipeline:
  processors:
    - metadata:
        correlation_id_field: "correlationId"
        add_timestamp: true
    - log:
        level: info
        include_content: true

output:
  aws_sqs:
    url: "https://sqs.us-east-1.amazonaws.com/123456789/webhooks-queue"
    region: "us-east-1"
```

### GitHub Webhook Receiver

```yaml
input:
  http:
    port: 8080
    path: "/github/webhook"

pipeline:
  processors:
    - metadata:
        correlation_id_field: "correlationId"
    - mapping:
        expression: |
          {
            "event": $headers."x-github-event",
            "repo": repository.full_name,
            "action": action,
            "sender": sender.login
          }

output:
  http:
    url: "https://internal-api.example.com/events"
    method: POST
    headers:
      Content-Type: "application/json"
```

## Features

- **Automatic JSON Parsing**: Parses JSON request bodies automatically
- **Fallback to Raw Text**: Non-JSON bodies are stored as raw text
- **Request Metadata**: Captures HTTP method, URL, headers, and query parameters
- **Correlation ID Tracking**: Auto-generates correlation IDs for request tracing
- **Performance Metrics**: Tracks request processing duration
- **Concurrent Handling**: Handles multiple concurrent requests
- **Graceful Shutdown**: Properly closes server on pipeline termination

## Request Processing

### JSON Request Body

When a valid JSON body is received:
```json
{
  "event": "user_signup",
  "user_id": 12345
}
```

It becomes a message with:
```json
{
  "messageId": "auto-generated-uuid",
  "correlationId": "auto-generated-uuid",
  "timestamp": 1234567890,
  "metadata": {
    "source": "http-input",
    "method": "POST",
    "url": "/webhook",
    "headers": { ... },
    "processingTime": 5
  },
  "content": {
    "event": "user_signup",
    "user_id": 12345
  }
}
```

### Non-JSON Request Body

Raw text or invalid JSON is stored as:
```json
{
  "content": {
    "raw": "the original body text"
  }
}
```

## Message Metadata

Each message includes the following metadata automatically:

- `source`: "http-input"
- `method`: HTTP method (always "POST" currently)
- `url`: Request URL path
- `headers`: All HTTP headers as key-value object
- `correlationId`: Auto-generated UUID for tracing
- `processingTime`: Request processing duration in milliseconds

## Testing

### Using curl

```bash
# Start the pipeline
cascade run webhook-config.yaml

# In another terminal, send a test request
curl -X POST http://localhost:8080/webhook \
  -H "Content-Type: application/json" \
  -d '{"event": "test", "message": "Hello!"}'
```

### Using httpie

```bash
http POST http://localhost:8080/webhook \
  event=test \
  message="Hello from httpie"
```

### Using JavaScript/fetch

```javascript
fetch('http://localhost:8080/webhook', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    event: 'test',
    message: 'Hello from JavaScript'
  })
})
```

## Use Cases

- **Webhook Receiver**: Receive webhooks from GitHub, Stripe, Twilio, etc.
- **Event Gateway**: Central entry point for external events
- **API Proxy**: Forward HTTP requests to message queues
- **Webhook Forwarder**: Receive and forward webhooks to multiple destinations
- **Integration Hub**: Connect HTTP-based services to message-based systems
- **Microservice Communication**: HTTP-to-SQS or HTTP-to-Redis bridges

## Response Codes

- `200 OK`: Request successfully received and queued for processing
- `404 Not Found`: Wrong URL path or HTTP method
- `500 Internal Server Error`: Server error during request processing

## Security Considerations

- The HTTP input does not include authentication by default
- Consider using a reverse proxy (nginx, Caddy) for:
  - TLS/HTTPS termination
  - Authentication (API keys, JWT validation)
  - Rate limiting
  - Request validation
- Bind to `localhost` if only accepting local connections
- Use firewall rules to restrict access

## Performance

- Lightweight Node.js HTTP server
- Non-blocking async request handling
- Automatic backpressure through Effect.js streams
- Configurable timeout prevents hanging connections
- Efficient JSON parsing with error handling

## Troubleshooting

### Port already in use

```
Error: listen EADDRINUSE: address already in use :::8080
```

**Solution**: Change the port or stop the conflicting service
```bash
# Find what's using the port
lsof -i :8080

# Or use a different port
input:
  http:
    port: 8081
```

### Requests timing out

**Solution**: Increase the timeout value
```yaml
input:
  http:
    port: 8080
    timeout: 60000  # 60 seconds
```

### JSON parsing errors

When you see: `Failed to parse request body as JSON, using raw`

**Solution**: This is normal for non-JSON bodies. The body is stored as raw text in `content.raw`.

### Cannot connect from external network

**Solution**: Ensure host is set to `0.0.0.0` (not `localhost`)
```yaml
input:
  http:
    port: 8080
    host: "0.0.0.0"  # Listen on all network interfaces
```

## Debug Mode

Use the `--debug` flag to see detailed request processing:

```bash
cascade run config.yaml --debug
```

Debug output shows:
- Incoming request details
- JSON parsing status
- Message creation
- Processing duration

## See Also

- [HTTP Output](../outputs/http.md) - Send HTTP requests
- [SQS Input](sqs.md) - Alternative message input
- [Redis Streams Input](redis-streams.md) - Alternative message input
- [Metadata Processor](../processors/metadata.md) - Add correlation IDs
- [Logging Processor](../processors/logging.md) - Debug message flow
