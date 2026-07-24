#!/bin/bash
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ROOT_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT_DIR"

COMPOSE_FILE="tests/e2e/infrastructure/http/docker-compose.yml"
LOG_FILE="/tmp/http-processor-post.log"

cleanup() {
  docker-compose -f "$COMPOSE_FILE" down -v >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo -e "${YELLOW}=== HTTP Processor POST with Result Mapping E2E Test ===${NC}\n"

echo -e "${YELLOW}Starting HTTP observer...${NC}"
docker-compose -f "$COMPOSE_FILE" down -v >/dev/null 2>&1 || true
docker-compose -f "$COMPOSE_FILE" up -d --force-recreate

echo "Waiting for HTTP observer health..."
ready=0
for i in $(seq 1 30); do
  if curl --fail --silent "http://127.0.0.1:8081/health" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo -e "${RED}HTTP observer is not ready${NC}"
  docker-compose -f "$COMPOSE_FILE" logs || true
  exit 1
fi
echo -e "${GREEN}HTTP observer ready${NC}\n"

echo -e "${YELLOW}Running HTTP processor POST pipeline...${NC}"
set +e
timeout -k 5s 30s node dist/cli.js run tests/e2e/configs/http-processor-post-test.yaml >"$LOG_FILE" 2>&1
CLI_STATUS=$?
set -e

cat "$LOG_FILE"

if [ "$CLI_STATUS" -ne 0 ]; then
  echo -e "${RED}Pipeline failed (exit $CLI_STATUS)${NC}"
  curl -s "http://127.0.0.1:8081/__requests" || true
  exit 1
fi

node tests/e2e/helpers/assert-http-requests.mjs processor-post

PROCESSED=$(grep -c "Processed: 3 messages" "$LOG_FILE" || true)
FAILED=$(grep -c "Failed: 0 messages" "$LOG_FILE" || true)

echo -e "\n${YELLOW}Results:${NC}"
echo -e "Processed summary lines: ${PROCESSED}"
echo -e "Failed summary lines: ${FAILED}"

if [ "$PROCESSED" -eq 1 ] && [ "$FAILED" -eq 1 ]; then
  echo -e "\n${GREEN}✓ HTTP Processor POST test PASSED${NC}"
  exit 0
fi

echo -e "\n${RED}✗ HTTP Processor POST test FAILED${NC}"
exit 1
