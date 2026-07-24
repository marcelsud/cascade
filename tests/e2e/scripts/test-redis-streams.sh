#!/bin/bash
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}=== Redis Streams E2E Test ===${NC}\n"

# Start Redis
echo -e "${YELLOW}Starting Redis...${NC}"
cd tests/e2e/infrastructure/redis
docker-compose down -v 2>/dev/null || true
docker-compose up -d
echo "Waiting for Redis to be healthy..."
sleep 5

# Check Redis health
if ! docker exec e2e-redis redis-cli ping > /dev/null 2>&1; then
    echo -e "${RED}Redis is not healthy${NC}"
    docker-compose logs
    exit 1
fi
echo -e "${GREEN}Redis is healthy${NC}\n"

# Go back to project root
cd ../../../..

# Clear the stream first
echo -e "${YELLOW}Clearing Redis stream...${NC}"
docker exec e2e-redis redis-cli DEL e2e-test-stream

# Run the producer pipeline
echo -e "${YELLOW}Running producer pipeline (writing to Redis stream)...${NC}"
if node dist/cli.js run tests/e2e/configs/redis-streams-producer.yaml; then
    echo -e "${GREEN}Producer completed successfully${NC}"
else
    echo -e "${RED}Producer failed${NC}"
    docker-compose -f tests/e2e/infrastructure/redis/docker-compose.yml logs
    exit 1
fi

# Check how many messages are in the stream
STREAM_LEN=$(docker exec e2e-redis redis-cli XLEN e2e-test-stream)
echo -e "\n${YELLOW}Messages in Redis stream: ${STREAM_LEN}${NC}"

if [ "$STREAM_LEN" -ne "5" ]; then
    echo -e "${RED}Expected 5 messages in stream, found ${STREAM_LEN}${NC}"
    exit 1
fi

# Run the consumer pipeline with timeout
echo -e "\n${YELLOW}Running consumer pipeline (reading from Redis stream)...${NC}"
timeout -k 5s 15s node dist/cli.js run tests/e2e/configs/redis-streams-consumer.yaml > /tmp/redis-streams-consumer.log 2>&1 &
CONSUMER_PID=$!

# Wait for consumer to process messages
sleep 10

# Kill the consumer if still running
kill $CONSUMER_PID 2>/dev/null || true
wait $CONSUMER_PID 2>/dev/null || true

# Show consumer output
cat /tmp/redis-streams-consumer.log

# Check if consumer got all messages
CONSUMED_COUNT=$(grep -c "Redis Streams message" /tmp/redis-streams-consumer.log || echo "0")
echo -e "\n${YELLOW}Messages consumed: ${CONSUMED_COUNT}${NC}"

# Stream messages persist, so check they're still there
STREAM_LEN_AFTER=$(docker exec e2e-redis redis-cli XLEN e2e-test-stream)
echo -e "${YELLOW}Messages in stream after consumption: ${STREAM_LEN_AFTER}${NC}"

if [ "$CONSUMED_COUNT" -eq "5" ] && [ "$STREAM_LEN_AFTER" -eq "5" ]; then
    echo -e "\n${GREEN}✓ Redis Streams test PASSED${NC}"
    echo -e "  - Produced 5 messages"
    echo -e "  - Consumed 5 messages"
    echo -e "  - Stream retains messages (${STREAM_LEN_AFTER} messages)"

    # Cleanup
    docker-compose -f tests/e2e/infrastructure/redis/docker-compose.yml down -v

    exit 0
else
    echo -e "\n${RED}✗ Redis Streams test FAILED${NC}"
    echo -e "  - Expected 5 consumed messages, got ${CONSUMED_COUNT}"
    echo -e "  - Expected 5 messages in stream, got ${STREAM_LEN_AFTER}"

    echo -e "\n${YELLOW}Redis logs:${NC}"
    docker-compose -f tests/e2e/infrastructure/redis/docker-compose.yml logs --tail=50

    docker-compose -f tests/e2e/infrastructure/redis/docker-compose.yml down -v

    exit 1
fi
