# HTTP Processor

## Overview

Makes HTTP requests to external APIs during message processing for enrichment, validation, or transformation. Supports JSONata templating for dynamic URLs and request bodies, with flexible response handling options.

## Configuration

### Required Fields

- `url`: HTTP endpoint URL (supports JSONata templating)
- `method`: HTTP method - "GET", "POST", "PUT", or "PATCH" (default: "GET")

### Optional Fields

- `headers`: Custom HTTP headers
- `body`: JSONata expression for request body (POST/PUT/PATCH only)
- `result_key`: Metadata key to store response (default: "http_response")
- `result_mapping`: JSONata expression to map response into content
- `timeout`: Request timeout in milliseconds (default: 30000)
- `max_retries`: Number of retry attempts (default: 3)

### Authentication Fields

- `auth.type`: Authentication type - "basic" or "bearer"
- `auth.username`: Username (for basic auth)
- `auth.password`: Password (for basic auth)
- `auth.token`: Token (for bearer auth)

## Examples

### Basic API Enrichment (Store in Metadata)

Fetch user data and store in metadata for later processing:

```yaml
pipeline:
  processors:
    # Fetch user details from API
    - http:
        url: "https://api.example.com/users/{{ content.userId }}"
        method: GET
        result_key: "user_data"  # Store response here
        auth:
          type: bearer
          token: "${API_TOKEN}"

    # Map the fetched data into message content
    - mapping:
        expression: |
          {
            $: $,
            "userName": meta.user_data.name,
            "userEmail": meta.user_data.email,
            "userTier": meta.user_data.subscription.tier
          }
```

### Direct Response Mapping (All-in-One)

Fetch and transform in a single processor:

```yaml
pipeline:
  processors:
    - http:
        url: "https://api.example.com/users/{{ content.userId }}"
        method: GET
        result_mapping: |
          {
            $: $,
            "userName": http_response.name,
            "userEmail": http_response.email,
            "accountStatus": http_response.status
          }
        auth:
          type: bearer
          token: "${API_TOKEN}"
```

### POST with Dynamic Body

Send data to an API with templated request body:

```yaml
pipeline:
  processors:
    - http:
        url: "https://api.example.com/validate"
        method: POST
        body: |
          {{
            {
              "transactionId": content.txId,
              "amount": content.amount,
              "currency": "USD",
              "timestamp": message.timestamp
            }
          }}
        result_key: "validation_result"
```

### Multi-Step Enrichment

Enrich from multiple APIs:

```yaml
pipeline:
  processors:
    # Step 1: Get user data
    - http:
        url: "https://api.example.com/users/{{ content.userId }}"
        method: GET
        result_key: "user_data"

    # Step 2: Get account balance
    - http:
        url: "https://api.example.com/accounts/{{ meta.user_data.accountId }}/balance"
        method: GET
        result_key: "account_balance"

    # Step 3: Combine everything
    - mapping:
        expression: |
          {
            $: $,
            "user": {
              "name": meta.user_data.name,
              "email": meta.user_data.email,
              "balance": meta.account_balance.amount
            }
          }
```

### Complex URL Templating

Build URLs dynamically from message data:

```yaml
pipeline:
  processors:
    - http:
        url: "https://api.example.com/{{ content.resource }}/{{ content.id }}/{{ content.action }}"
        method: GET
        result_mapping: |
          {
            $: $,
            "apiResult": http_response
          }
```

Given message:
```json
{
  "resource": "orders",
  "id": "12345",
  "action": "status"
}
```

Calls: `https://api.example.com/orders/12345/status`

### API Validation

Validate data with external service:

```yaml
pipeline:
  processors:
    - http:
        url: "https://validator.example.com/check"
        method: POST
        body: |
          {{
            {
              "email": content.email,
              "phone": content.phone
            }
          }}
        result_mapping: |
          {
            $: $,
            "isValid": http_response.valid,
            "validationErrors": http_response.errors
          }
```

### Conditional API Calls

Use JSONata logic to build conditional requests:

```yaml
pipeline:
  processors:
    - http:
        url: "{{ content.isPremium ? 'https://api.example.com/premium/users/' & content.id : 'https://api.example.com/users/' & content.id }}"
        method: GET
        result_key: "user_profile"
```

### Custom Headers

Add custom headers to requests:

```yaml
pipeline:
  processors:
    - http:
        url: "https://api.example.com/data"
        method: GET
        headers:
          X-API-Key: "your-api-key-here"
          X-Request-ID: "{{ message.correlationId }}"
          X-Source: "cascade"
        result_key: "api_data"
```

## Features

- **JSONata URL Templating**: Build dynamic URLs using message content, metadata, and context
- **JSONata Request Bodies**: Template POST/PUT/PATCH bodies with full JSONata expressions
- **Dual Response Modes**:
  - **Metadata Storage**: Store response in metadata for later mapping (default)
  - **Direct Mapping**: Transform response inline with JSONata (all-in-one)
- **Authentication**: Built-in Bearer token and Basic auth support
- **Retry Logic**: Automatic retry with exponential backoff (5xx errors, rate limits)
- **Error Categorization**: Smart handling of different HTTP errors
- **Custom Headers**: Add any headers needed for your API
- **Timeout Control**: Configurable request timeout

## JSONata Context

All JSONata expressions have access to:

- `content`: Message content
- `meta`: Message metadata
- `message`: Message properties (id, timestamp, correlationId)
- `http_response`: HTTP response (in result_mapping only)

## Response Storage Modes

### Mode 1: Metadata Storage (Default)

Store response in metadata, process later with mapping processor:

```yaml
- http:
    url: "https://api.example.com/user/123"
    method: GET
    result_key: "user_data"  # Stored in metadata.user_data
```

**Pros:**
- Clear separation of concerns
- Easier debugging (can inspect raw response)
- Can reference response in multiple places

**Cons:**
- Requires additional mapping processor
- Slightly more verbose

### Mode 2: Direct Mapping

Map response directly into content:

```yaml
- http:
    url: "https://api.example.com/user/123"
    method: GET
    result_mapping: |
      {
        $: $,
        "enrichedData": http_response
      }
```

**Pros:**
- Single processor handles fetch + transform
- More concise for simple cases
- Better performance (fewer processors)

**Cons:**
- Less flexible
- Harder to debug (no raw response in metadata)

## URL Templating

### Simple Field Interpolation

```yaml
url: "https://api.example.com/users/{{ content.userId }}"
```

### Nested Fields

```yaml
url: "https://api.example.com/orgs/{{ content.org.id }}/users/{{ content.user.id }}"
```

### JSONata Expressions

```yaml
url: "{{ 'https://api.example.com/' & content.resource & '/' & content.id }}"
```

### Conditional Logic

```yaml
url: "{{ content.env = 'prod' ? 'https://api.prod.com' : 'https://api.dev.com' }}/users"
```

## Request Body Templating

### Static JSON with Variables

```yaml
body: |
  {{
    {
      "userId": content.id,
      "action": "update",
      "timestamp": message.timestamp
    }
  }}
```

### Dynamic Object Construction

```yaml
body: |
  {{
    {
      "user": content.user,
      "metadata": meta,
      "enriched": $merge([content, {"processed": true}])
    }
  }}
```

### Array Transformations

```yaml
body: |
  {{
    {
      "items": content.items.[{
        "id": id,
        "price": price,
        "total": price * quantity
      }]
    }
  }}
```

## Error Handling

The HTTP processor categorizes errors for appropriate handling:

### Intermittent Errors (Will Retry)
- 5xx server errors
- Network/connection errors
- Timeouts
- 429 Rate Limit errors

### Logical Errors (Won't Retry)
- 4xx client errors (except 429)
- Invalid request format
- Authentication failures
- JSONata evaluation errors

### Retry Behavior

```
1. First attempt: Immediate
2. Retry 1: Wait 1 second
3. Retry 2: Wait 2 seconds
4. Retry 3: Wait 4 seconds

After max_retries: Send to DLQ (if configured)
```

## Use Cases

### User Enrichment

Fetch user profile data from an authentication service:

```yaml
- http:
    url: "https://auth.example.com/users/{{ content.userId }}"
    method: GET
    result_mapping: |
      {
        $: $,
        "user": {
          "name": http_response.fullName,
          "email": http_response.email,
          "roles": http_response.roles
        }
      }
```

### Fraud Detection

Send transaction to fraud detection API:

```yaml
- http:
    url: "https://fraud-detection.example.com/check"
    method: POST
    body: |
      {{
        {
          "transactionId": content.id,
          "amount": content.amount,
          "userId": content.userId,
          "location": content.geoLocation
        }
      }}
    result_key: "fraud_check"
```

### External Validation

Validate address with external service:

```yaml
- http:
    url: "https://address-validator.example.com/validate"
    method: POST
    body: |
      {{
        {
          "street": content.address.street,
          "city": content.address.city,
          "zipCode": content.address.zip
        }
      }}
    result_mapping: |
      {
        $: $,
        "addressValid": http_response.isValid,
        "standardizedAddress": http_response.standardized
      }
```

### Webhook Notifications

Send webhooks to external systems:

```yaml
- http:
    url: "{{ content.webhookUrl }}"
    method: POST
    body: |
      {{
        {
          "event": content.eventType,
          "data": content.data,
          "timestamp": message.timestamp
        }
      }}
    headers:
      X-Webhook-Secret: "${WEBHOOK_SECRET}"
```

### Price Lookups

Fetch current prices from pricing API:

```yaml
- http:
    url: "https://pricing.example.com/products/{{ content.productId }}/price"
    method: GET
    headers:
      X-API-Key: "${PRICING_API_KEY}"
    result_mapping: |
      {
        $: $,
        "price": http_response.currentPrice,
        "currency": http_response.currency
      }
```

## Troubleshooting

### Request Failures

**Problem**: HTTP processor fails with network errors

**Solutions:**
1. Check API endpoint is accessible
2. Verify authentication credentials
3. Increase `timeout` if API is slow
4. Check firewall rules and network connectivity

### Template Evaluation Errors

**Problem**: "Failed to evaluate template" error

**Solutions:**
1. Verify JSONata syntax is correct
2. Ensure referenced fields exist in message
3. Test expression with simpler data first
4. Check for proper quoting in YAML

### Response Mapping Errors

**Problem**: "Failed to map HTTP response" error

**Solutions:**
1. Verify `result_mapping` JSONata syntax
2. Check `http_response` variable is used correctly
3. Ensure API returns expected JSON structure
4. Add error handling in JSONata expression

### Authentication Issues

**Problem**: 401 Unauthorized or 403 Forbidden

**Solutions:**
1. Verify API credentials are correct
2. Check token hasn't expired
3. Ensure auth type matches API requirements
4. Verify headers are set correctly

### Rate Limiting

**Problem**: 429 Too Many Requests

**Solutions:**
1. Processor will automatically retry
2. Increase `max_retries` if needed
3. Add delays between messages (use backpressure config)
4. Check API rate limit documentation

## Performance Considerations

- **Latency**: Each HTTP call adds network latency to message processing
- **Concurrency**: HTTP calls happen per message; control with backpressure settings
- **Timeout**: Set appropriate timeouts for your API's response time
- **Caching**: Consider caching frequent lookups externally (not built-in)
- **Batch APIs**: If API supports batch operations, collect messages first

## Comparison with HTTP Output

| Feature | HTTP Processor | HTTP Output |
|---------|---------------|-------------|
| Purpose | Enrich messages | Send messages |
| Response | Captured and used | Discarded |
| Methods | GET, POST, PUT, PATCH | POST, PUT, PATCH |
| Template | URL + Body | None (sends whole message) |
| Use Case | API enrichment | Webhooks, API publishing |

**When to use HTTP Processor:**
- Fetch data to enrich messages
- Validate data with external APIs
- Transform messages based on API responses

**When to use HTTP Output:**
- Forward messages to external systems
- Send webhooks
- Publish to APIs (no response needed)
