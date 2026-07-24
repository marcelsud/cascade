#!/bin/bash
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ROOT_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT_DIR"

LOG_FILE="/tmp/http-input.log"
SERVER_PID=""
FORCE_KILL=0

cleanup_on_fail() {
  if [ -n "${SERVER_PID}" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill -TERM "$SERVER_PID" 2>/dev/null || true
    sleep 1
    kill -KILL "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}

# Only force-reap on unexpected failure paths; success path captures wait status itself.
trap 'if [ "$FORCE_KILL" -eq 1 ]; then cleanup_on_fail; fi' EXIT

echo -e "${YELLOW}=== HTTP Input (Webhook) E2E Test ===${NC}\n"

echo -e "${YELLOW}Starting HTTP webhook server...${NC}"
# No outer timeout wrapper so graceful SIGTERM can return 0
node dist/cli.js run tests/e2e/configs/http-input-test.yaml >"$LOG_FILE" 2>&1 &
SERVER_PID=$!
FORCE_KILL=1

echo "Waiting for server to start..."
ready=0
for i in $(seq 1 10); do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8090/webhook || true)
  if [ "$code" = "404" ]; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo -e "${RED}Server failed to start with GET 404 readiness${NC}"
  cat "$LOG_FILE" || true
  exit 1
fi
echo -e "${GREEN}Server is ready (GET /webhook -> 404)${NC}\n"

echo -e "${YELLOW}Sending webhook requests...${NC}"
for i in 1 2 3; do
  echo "Sending message $i..."
  resp=$(curl -s -w "|%{http_code}" -X POST http://127.0.0.1:8090/webhook \
    -H "Content-Type: application/json" \
    -d "{\"messageId\": \"webhook-$i\", \"content\": \"Test webhook message $i\", \"timestamp\": \"$(date +%s)\"}")
  body="${resp%|*}"
  status="${resp##*|}"
  echo "Response: body=${body} status=${status}"
  if [ "$body" != "OK" ] || [ "$status" != "200" ]; then
    echo -e "${RED}Expected OK|200, got ${body}|${status}${NC}"
    cat "$LOG_FILE" || true
    exit 1
  fi
done

echo "Waiting for messages to be processed..."
seen=0
for i in $(seq 1 10); do
  if node --input-type=module -e '
import fs from "node:fs";
const log = fs.readFileSync(process.argv[1], "utf8");
// Prefer pretty multi-line JSON blocks; fall back to escaped single-line logs.
const pairs = new Map();
const blockRe = /"content":\s*\{([\s\S]*?)\n\s*\}/g;
let m;
while ((m = blockRe.exec(log))) {
  const block = m[1];
  const id = block.match(/"messageId":\s*"(webhook-\d+)"/);
  const content = block.match(/"content":\s*"(Test webhook message \d+)"/);
  if (id && content) {
    const key = `${id[1]}|${content[1]}`;
    pairs.set(key, (pairs.get(key) || 0) + 1);
  }
}
if (pairs.size === 0) {
  const escRe = /\\"messageId\\":\s*\\"(webhook-\d+)\\"[\s\S]*?\\"content\\":\s*\\"(Test webhook message \d+)\\"/g;
  while ((m = escRe.exec(log))) {
    const key = `${m[1]}|${m[2]}`;
    pairs.set(key, (pairs.get(key) || 0) + 1);
  }
}
const expected = [
  "webhook-1|Test webhook message 1",
  "webhook-2|Test webhook message 2",
  "webhook-3|Test webhook message 3",
];
for (const key of expected) {
  if (pairs.get(key) !== 1) process.exit(1);
}
// No extra unexpected pairs
for (const key of pairs.keys()) {
  if (!expected.includes(key)) process.exit(1);
}
process.exit(0);
' "$LOG_FILE"; then
    seen=1
    break
  fi
  sleep 1
done
if [ "$seen" -ne 1 ]; then
  echo -e "${RED}Did not observe each exact messageId/content pair once within 10s${NC}"
  cat "$LOG_FILE" || true
  exit 1
fi

echo -e "\n${YELLOW}Stopping server with SIGTERM...${NC}"
kill -TERM "$SERVER_PID" 2>/dev/null || true

set +e
for i in $(seq 1 10); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    break
  fi
  sleep 1
done
if kill -0 "$SERVER_PID" 2>/dev/null; then
  echo -e "${RED}Server did not shut down within 10s${NC}"
  cat "$LOG_FILE" || true
  exit 1
fi
wait "$SERVER_PID"
WAIT_STATUS=$?
set -e

FORCE_KILL=0
SERVER_PID=""

echo -e "\n${YELLOW}Server output:${NC}"
cat "$LOG_FILE"

PROCESSED=$(grep -c "Processed: 3 messages" "$LOG_FILE" || true)
FAILED=$(grep -c "Failed: 0 messages" "$LOG_FILE" || true)

echo -e "\n${YELLOW}Results:${NC}"
echo -e "wait status: ${WAIT_STATUS}"
echo -e "Processed summary lines: ${PROCESSED}"
echo -e "Failed summary lines: ${FAILED}"

if [ "$WAIT_STATUS" -eq 0 ] && [ "$PROCESSED" -eq 1 ] && [ "$FAILED" -eq 1 ]; then
  echo -e "\n${GREEN}✓ HTTP Input test PASSED${NC}"
  exit 0
fi

echo -e "\n${RED}✗ HTTP Input test FAILED${NC}"
exit 1
