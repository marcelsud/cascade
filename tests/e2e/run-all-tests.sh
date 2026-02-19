#!/bin/bash
set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}╔════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║                                                        ║${NC}"
echo -e "${BLUE}║           Cascade - E2E Test Suite Runner              ║${NC}"
echo -e "${BLUE}║                                                        ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════╝${NC}"
echo ""

# Track results
TOTAL=0
PASSED=0
FAILED=0
FAILED_TESTS=()

run_test() {
    local test_name=$1
    local script=$2

    TOTAL=$((TOTAL + 1))
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BLUE}Running Test $TOTAL: $test_name${NC}"
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

    if ./$script; then
        echo -e "${GREEN}✓ $test_name PASSED${NC}\n"
        PASSED=$((PASSED + 1))
    else
        echo -e "${RED}✗ $test_name FAILED${NC}\n"
        FAILED=$((FAILED + 1))
        FAILED_TESTS+=("$test_name")
    fi
}

# Ensure we're in project root
cd "$(dirname "$0")/../.."

# Build project first
echo -e "${YELLOW}Building project...${NC}"
npm run build
echo ""

# Run all E2E tests
run_test "Redis Pub/Sub" "tests/e2e/scripts/test-redis-pubsub.sh"
run_test "Redis Lists" "tests/e2e/scripts/test-redis-list.sh"
run_test "Redis Streams" "tests/e2e/scripts/test-redis-streams.sh"
run_test "SQS (LocalStack)" "tests/e2e/scripts/test-sqs.sh"
run_test "HTTP Input" "tests/e2e/scripts/test-http-input.sh"
run_test "HTTP Output" "tests/e2e/scripts/test-http-output.sh"
run_test "HTTP Processor (Basic)" "tests/e2e/scripts/test-http-processor.sh"
run_test "HTTP Processor POST" "tests/e2e/scripts/test-http-processor-post.sh"
run_test "HTTP Processor Auth" "tests/e2e/scripts/test-http-processor-auth.sh"
run_test "HTTP Processor Errors" "tests/e2e/scripts/test-http-processor-errors.sh"
run_test "HTTP Processor Retry" "tests/e2e/scripts/test-http-processor-retry.sh"
run_test "HTTP Processor Templates" "tests/e2e/scripts/test-http-processor-templates.sh"

# Print summary
echo -e "${BLUE}╔════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║                    Test Summary                        ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "Total Tests:  ${BLUE}$TOTAL${NC}"
echo -e "Passed:       ${GREEN}$PASSED${NC}"
echo -e "Failed:       ${RED}$FAILED${NC}"
echo ""

if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}╔════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║                                                        ║${NC}"
    echo -e "${GREEN}║          ✓ All E2E Tests Passed! (100%)                ║${NC}"
    echo -e "${GREEN}║                                                        ║${NC}"
    echo -e "${GREEN}╚════════════════════════════════════════════════════════╝${NC}"
    exit 0
else
    echo -e "${RED}╔════════════════════════════════════════════════════════╗${NC}"
    echo -e "${RED}║                                                        ║${NC}"
    echo -e "${RED}║                 ✗ Tests Failed                         ║${NC}"
    echo -e "${RED}║                                                        ║${NC}"
    echo -e "${RED}╚════════════════════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "${RED}Failed tests:${NC}"
    for test in "${FAILED_TESTS[@]}"; do
        echo -e "  ${RED}✗${NC} $test"
    done
    echo ""
    echo -e "Check logs in ${YELLOW}e2e/results/${NC} for details"
    exit 1
fi
