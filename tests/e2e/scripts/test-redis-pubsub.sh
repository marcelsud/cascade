#!/bin/bash
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}=== Redis Pub/Sub E2E Test ===${NC}\n"

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


# Subscribe to the channel and capture messages
echo -e "${YELLOW}Starting Redis subscriber in background...${NC}"
RECEIVED_FILE="tests/e2e/results/redis-pubsub-received.txt"
mkdir -p tests/e2e/results
> "$RECEIVED_FILE"  # Clear file

# Use redis-cli to subscribe and save messages
timeout 15 docker exec e2e-redis redis-cli SUBSCRIBE e2e-test-channel | while read -r line; do
    echo "$line" >> "$RECEIVED_FILE"
done &
SUBSCRIBER_PID=$!

# Give subscriber time to connect
sleep 2

# Run the producer pipeline
echo -e "${YELLOW}Running producer pipeline...${NC}"
if node dist/cli.js run tests/e2e/configs/redis-pubsub-test.yaml; then
    echo -e "${GREEN}Producer completed successfully${NC}"
else
    echo -e "${RED}Producer failed${NC}"
    kill $SUBSCRIBER_PID 2>/dev/null || true
    docker-compose -f tests/e2e/infrastructure/redis/docker-compose.yml logs
    exit 1
fi

# Wait a bit for messages to be received
sleep 3

# Kill subscriber
kill $SUBSCRIBER_PID 2>/dev/null || true

# Verify messages were received
echo -e "\n${YELLOW}Verifying results...${NC}"
RECEIVED_COUNT=$(grep -c "Test message" "$RECEIVED_FILE" || echo "0")

echo "Messages received: $RECEIVED_COUNT"
cat "$RECEIVED_FILE"

if [ "$RECEIVED_COUNT" -ge "10" ]; then
    echo -e "\n${GREEN}✓ Redis Pub/Sub test PASSED${NC}"
    echo -e "  - Sent 10 messages"
    echo -e "  - Received $RECEIVED_COUNT messages"

    # Cleanup
    docker-compose -f tests/e2e/infrastructure/redis/docker-compose.yml down -v

    exit 0
else
    echo -e "\n${RED}✗ Redis Pub/Sub test FAILED${NC}"
    echo -e "  - Expected at least 10 messages"
    echo -e "  - Received $RECEIVED_COUNT messages"

    echo -e "\n${YELLOW}Redis logs:${NC}"
    docker-compose -f tests/e2e/infrastructure/redis/docker-compose.yml logs --tail=50

    docker-compose -f tests/e2e/infrastructure/redis/docker-compose.yml down -v

    exit 1
fi
