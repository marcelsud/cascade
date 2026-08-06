#!/usr/bin/env bash
# sonar-precommit.sh — local SonarQube gate for Cascade worktrees.
#
# Runs from a worktree root (or any cwd inside one). Fails the commit when:
#   - SonarQube is unreachable / unauthenticated
#   - the scanner or CE task fails
#   - the project quality gate is not OK
#   - any unresolved issue remains (bugs / vulns / smells)
#
# Env:
#   SONAR_HOST_URL   default http://127.0.0.1:9000
#   SONAR_TOKEN      required (or readable token file below)
#   SONAR_TOKEN_FILE default $HOME/sonar-experiment/token.txt
#   SONAR_SCANNER    optional absolute path to sonar-scanner
#   SONAR_WITH_COVERAGE=1  run npm run test:coverage before scan (slow)
#   SKIP_SONAR=1           no-op success (also: git commit --no-verify)
#   SONAR_PRECOMMIT_STRICT_SRC=1  only run when staged paths touch src/ or tests/
#                                 or sonar-project.properties (default: always)
#
set -euo pipefail

log()  { printf 'sonar-precommit: %s\n' "$*"; }
fail() { printf 'sonar-precommit: ERROR: %s\n' "$*" >&2; exit 1; }

if [[ "${SKIP_SONAR:-}" == "1" ]]; then
  log "SKIP_SONAR=1 — skipping Sonar gate"
  exit 0
fi

# Resolve worktree root (bare-worktree safe).
ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" \
  || fail "not inside a git worktree"
cd "$ROOT"

if [[ ! -f sonar-project.properties ]]; then
  fail "no sonar-project.properties at $ROOT (run from a Cascade worktree)"
fi

# Optional: only gate when relevant paths are staged (pre-commit) or always.
if [[ "${SONAR_PRECOMMIT_STRICT_SRC:-}" == "1" ]] && [[ -n "${GIT_INDEX_FILE:-}" || -d .git || -f .git ]]; then
  if git rev-parse --verify HEAD >/dev/null 2>&1; then
    staged="$(git diff --cached --name-only --diff-filter=ACMR 2>/dev/null || true)"
  else
    staged="$(git diff --cached --name-only --diff-filter=ACMR 2>/dev/null || true)"
  fi
  if [[ -n "$staged" ]]; then
    if ! printf '%s\n' "$staged" | grep -Eq '^(src/|tests/|sonar-project\.properties)'; then
      log "no staged src/tests/sonar changes — skipping Sonar gate"
      exit 0
    fi
  fi
fi

HOST="${SONAR_HOST_URL:-http://127.0.0.1:9000}"
HOST="${HOST%/}"

TOKEN="${SONAR_TOKEN:-}"
if [[ -z "$TOKEN" ]]; then
  TOKEN_FILE="${SONAR_TOKEN_FILE:-$HOME/sonar-experiment/token.txt}"
  if [[ -r "$TOKEN_FILE" ]]; then
    TOKEN="$(<"$TOKEN_FILE")"
  fi
fi
[[ -n "$TOKEN" ]] || fail "SONAR_TOKEN not set and no readable token file"

# Locate scanner.
SCANNER="${SONAR_SCANNER:-}"
if [[ -z "$SCANNER" ]]; then
  if command -v sonar-scanner >/dev/null 2>&1; then
    SCANNER="$(command -v sonar-scanner)"
  elif [[ -x "$HOME/sonar-experiment/sonar-scanner" ]]; then
    SCANNER="$HOME/sonar-experiment/sonar-scanner"
  elif [[ -x "$HOME/sonar-experiment/scanner/sonar-scanner-8.1.0.6389-linux-x64/bin/sonar-scanner" ]]; then
    SCANNER="$HOME/sonar-experiment/scanner/sonar-scanner-8.1.0.6389-linux-x64/bin/sonar-scanner"
  fi
fi
[[ -n "$SCANNER" && -x "$SCANNER" ]] || fail "sonar-scanner not found (set SONAR_SCANNER)"

# Project key from properties (fallback cascade).
PROJECT_KEY="$(
  awk -F= '/^sonar\.projectKey=/{print $2; exit}' sonar-project.properties
)"
PROJECT_KEY="${PROJECT_KEY:-cascade}"

# Health + auth.
status_json="$(curl -fsS "$HOST/api/system/status" 2>/dev/null)" \
  || fail "SonarQube not reachable at $HOST (is the container up?)"
status="$(printf '%s' "$status_json" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p')"
[[ "$status" == "UP" ]] || fail "SonarQube status is '$status' (want UP)"

auth_ok="$(curl -fsS -u "$TOKEN:" "$HOST/api/authentication/validate" \
  | sed -n 's/.*"valid":\([^,}]*\).*/\1/p')"
[[ "$auth_ok" == "true" ]] || fail "SONAR_TOKEN rejected by $HOST"

log "host=$HOST project=$PROJECT_KEY worktree=$ROOT"

if [[ "${SONAR_WITH_COVERAGE:-}" == "1" ]]; then
  log "SONAR_WITH_COVERAGE=1 — running test:coverage"
  npm run test:coverage
else
  log "scanning without fresh coverage (set SONAR_WITH_COVERAGE=1 to include lcov)"
fi

rm -rf .scannerwork
log "running sonar-scanner…"
scan_log="$(mktemp -t sonar-precommit.XXXXXX.log)"
cleanup() { rm -f "$scan_log"; }
trap cleanup EXIT

if ! "$SCANNER" \
  -Dsonar.host.url="$HOST" \
  -Dsonar.token="$TOKEN" \
  -Dsonar.scm.forceReloadAll=true \
  >"$scan_log" 2>&1; then
  tail -n 40 "$scan_log" >&2 || true
  fail "sonar-scanner failed (see log tail above)"
fi

TASK_URL="$(grep -E 'More about the report processing at' "$scan_log" | tail -n1 | awk '{print $NF}')"
[[ -n "$TASK_URL" ]] || fail "could not find CE task URL in scanner output"

# Wait for Compute Engine.
log "waiting for CE task…"
deadline=$((SECONDS + 180))
ce_status=""
while (( SECONDS < deadline )); do
  ce_json="$(curl -fsS -u "$TOKEN:" "$TASK_URL")"
  ce_status="$(printf '%s' "$ce_json" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p' | head -n1)"
  case "$ce_status" in
    SUCCESS) break ;;
    FAILED|CANCELED)
      printf '%s\n' "$ce_json" | tail -c 2000 >&2
      fail "CE task $ce_status"
      ;;
    *) sleep 1 ;;
  esac
done
[[ "$ce_status" == "SUCCESS" ]] || fail "CE task timed out (last status=$ce_status)"

# Quality gate.
qg_json="$(curl -fsS -u "$TOKEN:" \
  "$HOST/api/qualitygates/project_status?projectKey=$PROJECT_KEY")"
qg_status="$(printf '%s' "$qg_json" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p' | head -n1)"
[[ "$qg_status" == "OK" ]] || {
  printf '%s\n' "$qg_json" >&2
  fail "quality gate status=$qg_status (want OK)"
}

# Unresolved issues (any severity).
issues_json="$(curl -fsS -u "$TOKEN:" \
  "$HOST/api/issues/search?componentKeys=$PROJECT_KEY&resolved=false&ps=1")"
total="$(printf '%s' "$issues_json" | sed -n 's/.*"total":\([0-9]*\).*/\1/p' | head -n1)"
total="${total:-0}"

if [[ "$total" != "0" ]]; then
  # Print a short sample to help the author.
  sample="$(curl -fsS -u "$TOKEN:" \
    "$HOST/api/issues/search?componentKeys=$PROJECT_KEY&resolved=false&ps=10")"
  printf '%s\n' "$sample" | sed -n 's/.*"message":"\([^"]*\)".*/  - \1/p' | head -n 10 >&2 || true
  fail "unresolved Sonar issues: $total (open $HOST/dashboard?id=$PROJECT_KEY)"
fi

log "OK — quality gate green, 0 unresolved issues"
exit 0
