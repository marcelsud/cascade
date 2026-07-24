# Local Development Setup

This guide covers setting up Cascade for local development using LocalStack and Redis via Docker Compose.

## Overview

For local development, Cascade uses:
- **LocalStack** - AWS service emulation (SQS, etc.) on port 4566
- **Redis** - Message streaming and caching on port 6379
- **Redis Commander** - Web UI for Redis inspection on port 8081

All services are automatically initialized via Docker Compose - no manual setup required.

The Compose files pin LocalStack Community `4.14.0`, the final unauthenticated
community release. Newer unified LocalStack images require an auth token.

## Prerequisites

- Docker and Docker Compose installed
- Node.js 18+ installed
- npm or yarn

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Start Infrastructure

Start LocalStack (SQS) and Redis using Docker Compose:

```bash
docker-compose up -d
```

This will automatically:
- Start LocalStack on port 4566
- Start Redis on port 6379 (with persistence)
- Start Redis Commander GUI on port 8081
- Create SQS queues: `test-queue`, `input-queue`, `output-queue`, `dlq-queue`
- Send 5 test messages to `test-queue`

**Wait ~10 seconds** for LocalStack to fully initialize.

### 3. Verify Services

Check that all services are running:

```bash
npm run docker:ps
```

Expected output:
```
NAME                           STATUS
cascade-localstack      Up (healthy)
cascade-redis           Up
cascade-redis-commander Up
cascade-init            Exited (0)
```

### 4. Run Example Pipeline

```bash
npm run run-pipeline configs/example-pipeline.yaml
```

This pipeline:
1. Reads messages from SQS (LocalStack)
2. Adds metadata and correlation IDs
3. Transforms fields to uppercase
4. Logs each message
5. Sends to Redis Streams

### 5. Verify Results

#### Option 1: Redis CLI

```bash
docker exec -it cascade-redis redis-cli XREAD COUNT 10 STREAMS processed-messages 0
```

#### Option 2: Redis Commander (Web UI)

Visit http://localhost:8081

Navigate to the `processed-messages` stream to see processed messages.

## Local Configuration Examples

### SQS Input (LocalStack)

```yaml
input:
  aws_sqs:
    url: "http://localhost:4566/000000000000/input-queue"
    region: "us-east-1"
    endpoint: "http://localhost:4566"  # LocalStack endpoint
    wait_time_seconds: 20
    max_number_of_messages: 10
```

### Redis Streams Output (Local)

```yaml
output:
  redis_streams:
    url: "redis://localhost:6379"
    stream: "processed-messages"
    max_length: 10000
```

### DLQ Configuration (LocalStack)

```yaml
dlq:
  max_retries: 3
  output:
    aws_sqs:
      url: "http://localhost:4566/000000000000/dlq-queue"
      region: "us-east-1"
      endpoint: "http://localhost:4566"
```

## Docker Commands Reference

### Start Services

```bash
# Using npm scripts
npm run docker:up

# Or directly
docker-compose up -d
```

### Stop Services

```bash
npm run docker:down
```

### View Logs

```bash
# All services
npm run docker:logs

# Specific service
docker-compose logs -f localstack
docker-compose logs -f redis
docker-compose logs -f redis-commander
```

### Check Service Health

```bash
npm run docker:ps
```

### Restart Services

```bash
docker-compose restart
```

## LocalStack AWS CLI Commands

### List SQS Queues

```bash
docker exec -it cascade-localstack \
  aws --endpoint-url=http://localhost:4566 sqs list-queues
```

### Send Test Message

```bash
docker exec -it cascade-localstack \
  aws --endpoint-url=http://localhost:4566 sqs send-message \
    --queue-url http://localhost:4566/000000000000/test-queue \
    --message-body '{"test": "message", "timestamp": "2024-01-01T00:00:00Z"}'
```

### Receive Messages

```bash
docker exec -it cascade-localstack \
  aws --endpoint-url=http://localhost:4566 sqs receive-message \
    --queue-url http://localhost:4566/000000000000/test-queue \
    --max-number-of-messages 10
```

### Purge Queue

```bash
docker exec -it cascade-localstack \
  aws --endpoint-url=http://localhost:4566 sqs purge-queue \
    --queue-url http://localhost:4566/000000000000/test-queue
```

## Redis Commands

### View Stream Messages

```bash
docker exec -it cascade-redis redis-cli \
  XREAD COUNT 10 STREAMS processed-messages 0
```

### Stream Info

```bash
docker exec -it cascade-redis redis-cli \
  XINFO STREAM processed-messages
```

### List All Keys

```bash
docker exec -it cascade-redis redis-cli KEYS '*'
```

### Clear Stream

```bash
docker exec -it cascade-redis redis-cli \
  DEL processed-messages
```

## Development Workflow

### 1. Modify Configuration

Edit your pipeline configuration in `configs/`:

```yaml
input:
  aws_sqs:
    url: "http://localhost:4566/000000000000/input-queue"
    endpoint: "http://localhost:4566"
    # ... other options

pipeline:
  processors:
    - logging:
        level: "debug"  # Enable debug logging
    # ... your processors

output:
  redis_streams:
    url: "redis://localhost:6379"
    stream: "test-output"
```

### 2. Run Pipeline

```bash
npm run run-pipeline configs/your-pipeline.yaml
```

### 3. Monitor

**Terminal 1: Pipeline logs**
```bash
npm run run-pipeline configs/your-pipeline.yaml
```

**Terminal 2: LocalStack logs**
```bash
docker-compose logs -f localstack
```

**Terminal 3: Redis Commander**
- Open http://localhost:8081
- Monitor streams in real-time

### 4. Test and Iterate

Send test messages:
```bash
docker exec -it cascade-localstack \
  aws --endpoint-url=http://localhost:4566 sqs send-message \
    --queue-url http://localhost:4566/000000000000/input-queue \
    --message-body '{"userId": "123", "action": "purchase"}'
```

Check results:
```bash
docker exec -it cascade-redis redis-cli \
  XREAD COUNT 1 STREAMS test-output 0
```

## Running Tests

### Unit Tests

```bash
npm run test:unit
```

Unit tests run without Docker dependencies.

### E2E Tests

E2E tests require the root Docker Compose LocalStack and Redis services. The
suite probes both services before collecting tests and fails with an actionable
error when either is unavailable; tests are never silently skipped.

```bash
# 1. Start infrastructure
docker compose up -d

# 2. Check service health
docker compose ps

# 3. Run E2E tests
bun run test:e2e
```

Each test creates uniquely named SQS queues and Redis keys and removes them in
cleanup hooks. To point the harness at non-default services, set
`CASCADE_E2E_SQS_ENDPOINT` and `CASCADE_E2E_REDIS_URL`.

### All Tests

```bash
npm test
```

## Troubleshooting

### LocalStack Not Starting

**Issue**: `cascade-localstack` container exiting

**Solution**:
```bash
# Check logs
docker-compose logs localstack

# Restart with clean state
docker-compose down -v
docker-compose up -d
```

### Redis Connection Refused

**Issue**: `ECONNREFUSED ::1:6379`

**Solution**:
```bash
# Check Redis is running
docker-compose ps redis

# Restart Redis
docker-compose restart redis
```

### Queues Not Created

**Issue**: Queue URLs return 404

**Solution**:
```bash
# Check init-queues logs
docker-compose logs init-queues

# Manually create queues
docker exec -it cascade-localstack \
  aws --endpoint-url=http://localhost:4566 sqs create-queue \
    --queue-name input-queue
```

### Port Conflicts

**Issue**: Ports 4566, 6379, or 8081 already in use

**Solution**:
```bash
# Find process using port
lsof -i :4566
lsof -i :6379
lsof -i :8081

# Kill process or change port in docker-compose.yml
```

### Redis Commander Not Accessible

**Issue**: http://localhost:8081 not loading

**Solution**:
```bash
# Check Redis Commander logs
docker-compose logs redis-commander

# Restart
docker-compose restart redis-commander
```

## Production vs Local Configuration

When moving from local to production, update these settings:

### SQS Input

**Local:**
```yaml
input:
  aws_sqs:
    url: "http://localhost:4566/000000000000/input-queue"
    endpoint: "http://localhost:4566"
    region: "us-east-1"
```

**Production:**
```yaml
input:
  aws_sqs:
    url: "https://sqs.us-east-1.amazonaws.com/123456789012/input-queue"
    region: "us-east-1"
    # No endpoint - uses real AWS
```

### Redis Output

**Local:**
```yaml
output:
  redis_streams:
    url: "redis://localhost:6379"
```

**Production:**
```yaml
output:
  redis_streams:
    url: "redis://production-redis.example.com:6379"
    # Or ElastiCache endpoint
    url: "rediss://master.my-cluster.cache.amazonaws.com:6379"
    tls: true
```

### Environment Variables

Use environment variables for flexible configuration:

```yaml
input:
  aws_sqs:
    url: "${SQS_QUEUE_URL}"
    region: "${AWS_REGION}"
    endpoint: "${AWS_ENDPOINT:-}"  # Empty in production
```

Environment interpolation is fail-closed for required references:

- `${NAME}` requires a non-empty value. Unset or empty values fail config load with an error that names `NAME`.
- `${NAME:-}` explicitly defaults to an empty string when unset or empty.
- `${NAME:-fallback}` uses `fallback` when unset or empty; otherwise the environment value is used (including values like `0`).

Malformed expressions (for example `${123INVALID}`) also fail config load instead of remaining unresolved.

**Local .env:**
```
SQS_QUEUE_URL=http://localhost:4566/000000000000/input-queue
AWS_REGION=us-east-1
AWS_ENDPOINT=http://localhost:4566
```

**Production .env:**
```
SQS_QUEUE_URL=https://sqs.us-east-1.amazonaws.com/123456789012/input-queue
AWS_REGION=us-east-1
# AWS_ENDPOINT not set
```

## Docker Compose Services

### LocalStack

```yaml
localstack:
  image: localstack/localstack:latest
  container_name: cascade-localstack
  ports:
    - "4566:4566"
  environment:
    - SERVICES=sqs
    - DEBUG=1
  healthcheck:
    test: ["CMD", "curl", "-f", "http://localhost:4566/_localstack/health"]
```

### Redis

```yaml
redis:
  image: redis:7-alpine
  container_name: cascade-redis
  command: redis-server --appendonly yes
  ports:
    - "6379:6379"
  volumes:
    - redis-data:/data
```

### Redis Commander

```yaml
redis-commander:
  image: rediscommander/redis-commander:latest
  container_name: cascade-redis-commander
  environment:
    - REDIS_HOSTS=local:cascade-redis:6379
  ports:
    - "8081:8081"
```

### Init Queues

```yaml
init-queues:
  image: amazon/aws-cli
  container_name: cascade-init
  depends_on:
    localstack:
      condition: service_healthy
  entrypoint: /bin/sh
  command: |
    # Creates queues and sends test messages
    # Runs once on startup
```

## See Also

- [Complete Component Catalog](README.md) - All available components
- [SQS Input Documentation](inputs/sqs.md) - Detailed SQS configuration
- [Redis Streams Documentation](outputs/redis-streams.md) - Redis configuration
- [DLQ Configuration](advanced/dlq.md) - Dead Letter Queue setup
- [Backpressure Control](advanced/backpressure.md) - Throughput tuning
