# HTTP Output

## Overview

Sends messages to HTTP/HTTPS endpoints with support for multiple HTTP methods, custom headers, authentication, and automatic retry with exponential backoff. Perfect for webhooks, API integrations, and event forwarding.

## Configuration

### Required Fields

- `url`: The target HTTP/HTTPS endpoint URL

### Optional Fields

- `method`: HTTP method to use: "POST", "PUT", or "PATCH" (default: "POST")
- `headers`: Custom HTTP headers as key-value pairs
- `timeout`: Request timeout in milliseconds (default: 30000)
- `max_retries`: Maximum retry attempts for failures (default: 3)
- `auth`: Authentication configuration (optional)
  - `type`: Authentication type: "basic" or "bearer"
  - `username`: Username for basic auth
  - `password`: Password for basic auth
  - `token`: Token for bearer auth

## Examples

### Basic Example (POST to Webhook)

```yaml
output:
  http:
    url: "https://webhook.site/74ed15d1-ebfe-4c99-be1b-751e821e084a"
    method: POST
```

### With Custom Headers

```yaml
output:
  http:
    url: "https://api.example.com/events"
    method: POST
    headers:
      Content-Type: "application/json"
      X-Custom-Header: "my-value"
      X-Request-ID: "unique-id-123"
```

### With Bearer Authentication

```yaml
output:
  http:
    url: "https://api.example.com/webhooks"
    method: POST
    timeout: 5000
    max_retries: 3
    auth:
      type: bearer
      token: "${API_TOKEN}"  # Use environment variable
```

### With Basic Authentication

```yaml
output:
  http:
    url: "https://api.example.com/data"
    method: PUT
    auth:
      type: basic
      username: "${API_USERNAME}"
      password: "${API_PASSWORD}"
```

### Advanced Example (PUT with Retry)

```yaml
output:
  http:
    url: "https://api.production.com/events"
    method: PUT
    timeout: 10000  # 10 second timeout
    max_retries: 5  # Retry up to 5 times
    headers:
      Content-Type: "application/json"
      User-Agent: "cascade/0.1.1"
      X-Environment: "production"
    auth:
      type: bearer
      token: "${PROD_API_TOKEN}"
```

## Message Format

The HTTP output sends the entire message as JSON in the request body:

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "timestamp": 1699876543210,
  "correlationId": "correlation-123",
  "metadata": {
    "source": "sqs-input",
    "custom_field": "value"
  },
  "content": {
    "your": "data",
    "goes": "here"
  },
  "trace": {
    "processingSteps": ["metadata", "mapping"]
  }
}
```

## Authentication

### Bearer Token

Best for API keys and JWT tokens:

```yaml
output:
  http:
    url: "https://api.example.com/webhook"
    auth:
      type: bearer
      token: "your-api-key-or-jwt-token"
```

Adds header: `Authorization: Bearer your-api-key-or-jwt-token`

### Basic Authentication

For username/password authentication:

```yaml
output:
  http:
    url: "https://api.example.com/webhook"
    auth:
      type: basic
      username: "myuser"
      password: "mypassword"
```

Adds header: `Authorization: Basic base64(myuser:mypassword)`

## Retry Behavior

The HTTP output automatically retries failed requests with exponential backoff:

- **Retry conditions**:
  - Network errors (connection refused, timeout)
  - 5xx server errors (500-599)

- **No retry**:
  - 4xx client errors (400-499) - treated as logical errors

- **Backoff strategy**:
  - Exponential backoff starting at 1 second
  - Example: 1s → 2s → 4s → 8s

```yaml
output:
  http:
    url: "https://api.example.com/webhook"
    max_retries: 3  # Will retry up to 3 times
    timeout: 5000   # 5 second timeout per attempt
```

## Error Handling

### HTTP Status Codes

- **2xx (Success)**: Message successfully sent
- **4xx (Client Error)**: Logged as logical error, no retry
- **5xx (Server Error)**: Retried with exponential backoff

### Network Errors

- Connection refused
- DNS resolution failures
- Timeout errors
- SSL/TLS errors

All network errors are retried automatically.

## Security Considerations

### Using Environment Variables

Always use environment variables for sensitive data:

```yaml
output:
  http:
    url: "${WEBHOOK_URL}"
    auth:
      type: bearer
      token: "${API_TOKEN}"
```

Set in your environment:
```bash
export WEBHOOK_URL="https://api.example.com/webhook"
export API_TOKEN="your-secret-token"
```

### HTTPS vs HTTP

- **Always use HTTPS in production** for encrypted communication
- HTTP is acceptable only for:
  - Local development (localhost)
  - Internal networks
  - Testing with webhook.site

### Rate Limiting

Consider adding delays or batch processing if the target API has rate limits. The HTTP output does not include built-in rate limiting.

## Monitoring

### Metrics

The HTTP output emits metrics every 100 messages:

```typescript
{
  component: "http-output",
  type: "output",
  messagesSent: 150,
  sendErrors: 2,
  averageDuration: 234,  // milliseconds
  totalDuration: 35100,
  timestamp: 1699876543210
}
```

### Logging

Set log level to `info` or `debug` to see HTTP request details:

```yaml
pipeline:
  processors:
    - log:
        level: info
```

## Testing

### Using webhook.site

[Webhook.site](https://webhook.site) provides free webhook testing endpoints:

```yaml
output:
  http:
    url: "https://webhook.site/74ed15d1-ebfe-4c99-be1b-751e821e084a"
    method: POST
```

Visit https://webhook.site/#!/74ed15d1-ebfe-4c99-be1b-751e821e084a to see incoming requests.

### Using curl

Test your endpoint manually:

```bash
curl -X POST https://your-api.com/webhook \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-token" \
  -d '{"test": "data"}'
```

## Common Use Cases

### 1. Webhook Notifications

Forward events to external systems:

```yaml
input:
  aws_sqs:
    url: "https://sqs.us-east-1.amazonaws.com/123/events"
    region: "us-east-1"

output:
  http:
    url: "https://hooks.slack.com/services/YOUR/WEBHOOK/URL"
    method: POST
```

### 2. API Integration

Send data to REST APIs:

```yaml
input:
  redis_streams:
    url: "redis://localhost:6379"
    stream: "events"

pipeline:
  processors:
    - mapping:
        expression: |
          {
            "event_type": eventType,
            "user_id": userId,
            "timestamp": $now()
          }

output:
  http:
    url: "https://api.example.com/events"
    method: POST
    auth:
      type: bearer
      token: "${API_KEY}"
```

### 3. Event Forwarding

Forward events between systems:

```yaml
input:
  http:
    port: 8080
    path: "/webhook"

pipeline:
  processors:
    - metadata:
        correlation_id_field: "requestId"

output:
  http:
    url: "https://downstream-service.com/events"
    method: POST
    max_retries: 5
```

## Troubleshooting

### Connection Refused

```
Failed to send HTTP POST request: Connection refused
```

**Causes**:
- Target service is down
- Incorrect URL or port
- Network/firewall blocking

**Solutions**:
- Verify URL is correct
- Check if target service is running
- Test with curl manually

### Authentication Errors (401/403)

```
HTTP POST request failed with status 401
```

**Causes**:
- Invalid credentials
- Expired token
- Missing authentication

**Solutions**:
- Verify token/credentials are correct
- Check token expiration
- Ensure auth type matches API requirements

### Timeout Errors

```
HTTP POST request timeout exceeded
```

**Solutions**:
- Increase `timeout` value
- Check target API response time
- Verify network connectivity

## Performance Tips

1. **Adjust timeout**: Match target API's typical response time
2. **Retry configuration**: Balance between reliability and speed
3. **Connection pooling**: The HttpClient automatically manages connections
4. **Headers**: Only include necessary headers to reduce request size

## Related Components

- **[HTTP Input](../inputs/http.md)**: Receive HTTP webhook requests
- **[AWS SQS Output](sqs.md)**: Send to message queues
- **[Redis Streams Output](redis-streams.md)**: Send to Redis streams
