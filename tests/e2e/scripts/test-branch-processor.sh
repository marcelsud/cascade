#!/bin/bash
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ROOT_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT_DIR"

LOG_FILE="/tmp/branch-processor.log"

echo -e "${YELLOW}=== Branch Processor E2E Test ===${NC}\n"

echo -e "${YELLOW}Running branch processor pipeline...${NC}"
set +e
timeout -k 5s 20s node dist/cli.js run tests/e2e/configs/branch-processor-test.yaml >"$LOG_FILE" 2>&1
CLI_STATUS=$?
set -e

cat "$LOG_FILE"

if [ "$CLI_STATUS" -ne 0 ]; then
  echo -e "${RED}Pipeline failed (exit $CLI_STATUS)${NC}"
  exit 1
fi

# Count final branchResult objects (nested branch logs + final log may duplicate;
# require exactly three final '"branchResult": {' markers as a stable gate).
BRANCH_RESULT=$(grep -c '"branchResult": {' "$LOG_FILE" || true)
SUCCESS_COUNT=$(grep -c "Processed: 3 messages" "$LOG_FILE" || true)

echo -e "\n${YELLOW}Results:${NC}"
echo -e "branchResult markers: ${BRANCH_RESULT}"
echo -e "Pipeline completed summaries: ${SUCCESS_COUNT}"

if [ "$BRANCH_RESULT" -eq 3 ] && [ "$SUCCESS_COUNT" -eq 1 ]; then
  echo -e "\n${GREEN}✓ Branch Processor test PASSED${NC}"
  exit 0
fi

echo -e "\n${RED}✗ Branch Processor test FAILED${NC}"
echo -e "  - Expected 3 branchResult markers and 1 completion summary"
exit 1
