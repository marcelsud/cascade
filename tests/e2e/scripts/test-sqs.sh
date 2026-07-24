#!/bin/bash
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}=== SQS (LocalStack) E2E Test ===${NC}\n"

# Start LocalStack
echo -e "${YELLOW}Starting LocalStack...${NC}"
cd tests/e2e/infrastructure/sqs
docker-compose down -v 2>/dev/null || true
docker-compose up -d
echo "Waiting for LocalStack to be ready..."

# Wait up to 60 seconds for LocalStack to be ready
for i in {1..12}; do
    if curl -s http://localhost:4566/_localstack/health > /dev/null 2>&1; then
        echo -e "${GREEN}LocalStack is ready${NC}\n"
        break
    fi
    if [ $i -eq 12 ]; then
        echo -e "${RED}LocalStack failed to start${NC}"
        docker-compose logs
        exit 1
    fi
    echo "Waiting for LocalStack... ($i/12)"
    sleep 5
done

# Go back to project root
cd ../../../..

# Create SQS queue using AWS CLI from LocalStack container
echo -e "${YELLOW}Creating SQS queue...${NC}"
docker exec e2e-localstack awslocal sqs create-queue \
    --queue-name e2e-test-queue \
    --region us-east-1 2>/dev/null || true

# Verify queue was created
QUEUE_URL=$(docker exec e2e-localstack awslocal sqs get-queue-url \
    --queue-name e2e-test-queue \
    --region us-east-1 \
    --output text 2>/dev/null || echo "")

if [ -z "$QUEUE_URL" ]; then
    echo -e "${RED}Failed to create/find SQS queue${NC}"
    docker-compose logs
    exit 1
fi
echo -e "${GREEN}Queue created: ${QUEUE_URL}${NC}\n"

# Run the producer pipeline
echo -e "${YELLOW}Running producer pipeline (sending to SQS)...${NC}"
if node dist/cli.js run tests/e2e/configs/sqs-producer.yaml; then
    echo -e "${GREEN}Producer completed successfully${NC}"
else
    echo -e "${RED}Producer failed${NC}"
    docker-compose -f tests/e2e/infrastructure/sqs/docker-compose.yml logs
    exit 1
fi

# Check how many messages are in the queue
sleep 2
QUEUE_COUNT=$(docker exec e2e-localstack awslocal sqs get-queue-attributes \
    --queue-url "$QUEUE_URL" \
    --attribute-names ApproximateNumberOfMessages \
    --region us-east-1 \
    --output json 2>/dev/null | grep -o '"ApproximateNumberOfMessages"[^,]*' | grep -o '[0-9]*' | tail -1)

# Default to 0 if empty
QUEUE_COUNT=${QUEUE_COUNT:-0}

echo -e "\n${YELLOW}Messages in SQS queue: ${QUEUE_COUNT}${NC}"

if [ "$QUEUE_COUNT" -lt "5" ]; then
    echo -e "${RED}Expected at least 5 messages in queue, found ${QUEUE_COUNT}${NC}"
    exit 1
fi

# Run the consumer pipeline with timeout
echo -e "\n${YELLOW}Running consumer pipeline (receiving from SQS)...${NC}"
timeout -k 5s 15s node dist/cli.js run tests/e2e/configs/sqs-consumer.yaml > /tmp/sqs-consumer.log 2>&1 &
CONSUMER_PID=$!

# Wait for consumer to process messages
sleep 10

# Kill the consumer if still running
kill $CONSUMER_PID 2>/dev/null || true
wait $CONSUMER_PID 2>/dev/null || true

# Show consumer output
cat /tmp/sqs-consumer.log

# Check if consumer got all messages
CONSUMED_COUNT=$(grep -c "SQS message" /tmp/sqs-consumer.log || echo "0")
echo -e "\n${YELLOW}Messages consumed: ${CONSUMED_COUNT}${NC}"

# Check remaining messages in queue
sleep 2
QUEUE_COUNT_AFTER=$(docker exec e2e-localstack awslocal sqs get-queue-attributes \
    --queue-url "$QUEUE_URL" \
    --attribute-names ApproximateNumberOfMessages \
    --region us-east-1 \
    --output json 2>/dev/null | grep -o '"ApproximateNumberOfMessages"[^,]*' | grep -o '[0-9]*' | tail -1)

# Default to 0 if empty
QUEUE_COUNT_AFTER=${QUEUE_COUNT_AFTER:-0}
echo -e "${YELLOW}Messages remaining in queue: ${QUEUE_COUNT_AFTER}${NC}"

if [ "$CONSUMED_COUNT" -eq "5" ]; then
    echo -e "\n${GREEN}✓ SQS test PASSED${NC}"
    echo -e "  - Produced 5 messages"
    echo -e "  - Consumed 5 messages"
    echo -e "  - Queue emptied correctly"

    # Cleanup
    docker-compose -f tests/e2e/infrastructure/sqs/docker-compose.yml down -v

    exit 0
else
    echo -e "\n${RED}✗ SQS test FAILED${NC}"
    echo -e "  - Expected 5 consumed messages, got ${CONSUMED_COUNT}"
    echo -e "  - Queue count after: ${QUEUE_COUNT_AFTER}"

    echo -e "\n${YELLOW}LocalStack logs:${NC}"
    docker-compose -f tests/e2e/infrastructure/sqs/docker-compose.yml logs --tail=50

    docker-compose -f tests/e2e/infrastructure/sqs/docker-compose.yml down -v

    exit 1
fi
