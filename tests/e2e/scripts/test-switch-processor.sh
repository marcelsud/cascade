#!/bin/bash
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ROOT_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT_DIR"

LOG_FILE="/tmp/switch-processor.log"

echo -e "${YELLOW}=== Switch Processor E2E Test ===${NC}\n"

echo -e "${YELLOW}Running switch processor pipeline...${NC}"
set +e
timeout -k 5s 20s node dist/cli.js run tests/e2e/configs/switch-processor-test.yaml >"$LOG_FILE" 2>&1
CLI_STATUS=$?
set -e

cat "$LOG_FILE"

if [ "$CLI_STATUS" -ne 0 ]; then
  echo -e "${RED}Pipeline failed (exit $CLI_STATUS)${NC}"
  exit 1
fi

ORDER_ROUTE=$(grep -c '"orderRoute"' "$LOG_FILE" || true)
REFUND_ROUTE=$(grep -c '"refundRoute"' "$LOG_FILE" || true)
DEFAULT_ROUTE=$(grep -c '"defaultRoute"' "$LOG_FILE" || true)
SUCCESS_COUNT=$(grep -c "Processed: 6 messages" "$LOG_FILE" || true)

echo -e "\n${YELLOW}Results:${NC}"
echo -e "Order routes: ${ORDER_ROUTE}"
echo -e "Refund routes: ${REFUND_ROUTE}"
echo -e "Default routes: ${DEFAULT_ROUTE}"
echo -e "Pipeline completed summaries: ${SUCCESS_COUNT}"

if [ "$ORDER_ROUTE" -eq 2 ] && [ "$REFUND_ROUTE" -eq 2 ] && [ "$DEFAULT_ROUTE" -eq 2 ] && [ "$SUCCESS_COUNT" -eq 1 ]; then
  echo -e "\n${GREEN}✓ Switch Processor test PASSED${NC}"
  exit 0
fi

echo -e "\n${RED}✗ Switch Processor test FAILED${NC}"
echo -e "  - Expected order/refund/default = 2/2/2 and one 6-message summary"
exit 1
