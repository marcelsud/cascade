#!/bin/bash
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ROOT_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT_DIR"

COMPOSE_FILE="tests/e2e/infrastructure/http/docker-compose.yml"
LOG_FILE="/tmp/http-processor-retry.log"
CONFIG_PATH="${CASCADE_E2E_CONFIG:-tests/e2e/configs/http-processor-retry-test.yaml}"

cleanup() {
  docker-compose -f "$COMPOSE_FILE" down -v >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo -e "${YELLOW}=== HTTP Processor Retry & Timeout E2E Test ===${NC}\n"
echo -e "Config: ${CONFIG_PATH}"

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

echo -e "${YELLOW}Running HTTP processor retry pipeline...${NC}"
set +e
# max_retries:2 with exponential 1s schedule can take several seconds per message
timeout -k 5s 30s node dist/cli.js run "$CONFIG_PATH" >"$LOG_FILE" 2>&1
CLI_STATUS=$?
set -e

cat "$LOG_FILE"

if [ "$CLI_STATUS" -ne 1 ]; then
  echo -e "${RED}Expected CLI exit 1, got ${CLI_STATUS}${NC}"
  curl -s "http://127.0.0.1:8081/__requests" || true
  exit 1
fi

node tests/e2e/helpers/assert-http-requests.mjs processor-retry

SUMMARY=$(grep -c "Pipeline completed: 0 processed, 2 failed" "$LOG_FILE" || true)

echo -e "\n${YELLOW}Results:${NC}"
echo -e "CLI exit: ${CLI_STATUS}"
echo -e "Failure summary lines: ${SUMMARY}"

if [ "$SUMMARY" -eq 1 ]; then
  echo -e "\n${GREEN}✓ HTTP Processor Retry test PASSED${NC}"
  exit 0
fi

echo -e "\n${RED}✗ HTTP Processor Retry test FAILED${NC}"
exit 1
