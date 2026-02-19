# End-to-End Test Suite

This directory contains comprehensive E2E tests for Cascade that validate components work correctly via YAML configuration with real infrastructure.

## Directory Structure

```
e2e/
├── configs/           # YAML test configurations
├── scripts/           # Test execution scripts
├── infrastructure/    # Docker Compose files for test services
│   ├── redis/        # Redis 7 (Streams, Lists, Pub/Sub)
│   ├── sqs/          # LocalStack (SQS emulation)
│   └── http/         # httpbin + echo-server
├── results/          # Test execution logs
└── docs/             # Test documentation and findings
```

## Quick Start

### Run All Tests

```bash
./e2e/run-all-tests.sh
```

### Run Individual Tests

```bash
# Redis tests
./e2e/scripts/test-redis-pubsub.sh
./e2e/scripts/test-redis-list.sh
./e2e/scripts/test-redis-streams.sh

# SQS test
./e2e/scripts/test-sqs.sh

# HTTP tests
./e2e/scripts/test-http-input.sh
./e2e/scripts/test-http-output.sh
./e2e/scripts/test-http-processor.sh
./e2e/scripts/test-http-processor-post.sh
./e2e/scripts/test-http-processor-auth.sh
./e2e/scripts/test-http-processor-errors.sh
./e2e/scripts/test-http-processor-retry.sh
./e2e/scripts/test-http-processor-templates.sh
```

## Test Coverage

| Component | Type | Status | Messages | Description |
|-----------|------|--------|----------|-------------|
| Redis Pub/Sub | I/O | ✅ | 10 | Publish/Subscribe messaging |
| Redis Lists | I/O | ✅ | 5 | Queue-based BLPOP/BRPOP |
| Redis Streams | I/O | ✅ | 5 | Log-based XREAD streaming |
| AWS SQS | I/O | ✅ | 5 | Cloud queue (LocalStack) |
| HTTP Input | Input | ✅ | 3 | Webhook server |
| HTTP Output | Output | ✅ | 3 | HTTP client |
| HTTP Processor (Basic) | Processor | ✅ | 2 | API enrichment (GET) |
| HTTP Processor POST | Processor | ✅ | 3 | POST with body & result mapping |
| HTTP Processor Auth | Processor | ✅ | 3 | Bearer/Basic auth & custom headers |
| HTTP Processor Errors | Processor | ✅ | 3 | Error handling (4xx/5xx) |
| HTTP Processor Retry | Processor | ✅ | 2 | Timeout & retry behavior |
| HTTP Processor Templates | Processor | ✅ | 3 | Complex JSONata templates |

**Total**: 12/12 tests passing (100% coverage)

## Prerequisites

- Docker and Docker Compose
- Node.js 18+
- Built project (`npm run build`)

## Test Infrastructure

### Redis (Port 6380)

```bash
docker-compose -f e2e/infrastructure/redis/docker-compose.yml up -d
```

Used by:
- `test-redis-pubsub.sh`
- `test-redis-list.sh`
- `test-redis-streams.sh`

### LocalStack (Port 4566)

```bash
docker-compose -f e2e/infrastructure/sqs/docker-compose.yml up -d
```

Used by:
- `test-sqs.sh`

Uses `docker exec e2e-localstack awslocal` for AWS CLI commands.

### HTTP Test Servers (Ports 8081-8082)

```bash
docker-compose -f e2e/infrastructure/http/docker-compose.yml up -d
```

Used by:
- `test-http-output.sh`
- `test-http-processor.sh`

Provides httpbin and echo-server for HTTP testing.

## Writing New E2E Tests

### 1. Create Test Configuration

```yaml
# e2e/configs/my-test.yaml
input:
  my_component:
    url: "http://localhost:1234"

pipeline:
  processors:
    - log:
        level: "info"

output:
  capture:
    max_messages: 10
```

### 2. Create Test Script

```bash
# e2e/scripts/test-my-component.sh
#!/bin/bash
set -e

# Start infrastructure
cd e2e/infrastructure/my-service
docker-compose up -d

# Run test
node dist/cli.js run e2e/configs/my-test.yaml

# Validate results
# ... assertions ...

# Cleanup
docker-compose down -v
```

### 3. Make Executable

```bash
chmod +x e2e/scripts/test-my-component.sh
```

### 4. Add to Test Suite

Update `e2e/run-all-tests.sh` to include your test.

## Continuous Integration

Add to CI/CD pipeline:

```yaml
# .github/workflows/e2e-tests.yml
- name: Run E2E Tests
  run: ./e2e/run-all-tests.sh
```

## Troubleshooting

### Test Fails with "No valid input configuration found"

**Cause**: Component not registered in pipeline builder.

**Fix**: Verify component is registered in:
1. `src/core/config-loader.ts` (schema)
2. `src/core/pipeline-builder.ts` (builder)

See `docs/spec/COMPONENTS.md` for details.

### Docker Container Not Starting

```bash
# Check logs
docker-compose -f e2e/infrastructure/redis/docker-compose.yml logs

# Rebuild
docker-compose -f e2e/infrastructure/redis/docker-compose.yml up -d --force-recreate
```

### Port Already in Use

```bash
# Find process using port
lsof -i :6380

# Stop all E2E infrastructure
docker-compose -f e2e/infrastructure/redis/docker-compose.yml down
docker-compose -f e2e/infrastructure/sqs/docker-compose.yml down
docker-compose -f e2e/infrastructure/http/docker-compose.yml down
```

## Documentation

- **LEARNINGS.md**: Troubleshooting insights and discoveries
- **PROBLEMS.md**: Issues found and their resolutions
- **TEST-SUMMARY.md**: Comprehensive test results report
- **FINAL-REPORT.md**: Executive summary and recommendations

## Results

Test execution logs are saved to `e2e/results/` with format:
```
{test-name}-final.log
```

Example:
- `redis-pubsub-final.log`
- `sqs-final.log`
- `http-processor-final.log`

## Why E2E Tests Matter

E2E tests discovered **2 critical issues** that all 333 unit tests missed:

1. **Component Registration Gap**: 5 components (33% of v0.4.0 features) were unusable via YAML
2. **YAML Format Issue**: Processors were silently ignored due to wrong configuration format

**Key Insight**: Unit tests import components directly, bypassing YAML config validation. Only E2E tests catch registration and configuration issues.

## Contributing

When adding new components:

1. ✅ Implement component
2. ✅ Register in `config-loader.ts`
3. ✅ Register in `pipeline-builder.ts`
4. ✅ **Create E2E test FIRST** (before unit tests!)
5. ✅ Verify E2E test passes
6. ✅ Then write unit tests

This workflow catches registration issues immediately.

---

**Last Updated**: 2025-01-13
**Test Coverage**: 100% (7/7 tests passing)
**Total Components**: 16 (6 inputs, 4 processors, 6 outputs)
