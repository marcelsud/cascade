#!/usr/bin/env bash
# Install Cascade git hooks into the shared bare repo.
# Safe to re-run. Affects every worktree under the cascade container.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" \
  || { echo "run from a Cascade worktree" >&2; exit 1; }

GIT_DIR="$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir)"
HOOKS_DIR="$GIT_DIR/hooks"
SRC="$ROOT/scripts/githooks/pre-commit"

[[ -f "$SRC" ]] || { echo "missing $SRC" >&2; exit 1; }
[[ -f "$ROOT/scripts/sonar-precommit.sh" ]] || {
  echo "missing $ROOT/scripts/sonar-precommit.sh" >&2
  exit 1
}

mkdir -p "$HOOKS_DIR"

# Wrapper resolves the *committing* worktree's gate script at commit time so:
# - older worktrees without the script skip cleanly
# - updates to scripts/sonar-precommit.sh apply without reinstall
cat >"$HOOKS_DIR/pre-commit" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
GATE="$ROOT/scripts/sonar-precommit.sh"
if [[ ! -f "$GATE" ]]; then
  echo "sonar-precommit: no scripts/sonar-precommit.sh in this worktree — skip" >&2
  exit 0
fi
exec bash "$GATE"
EOF
chmod +x "$HOOKS_DIR/pre-commit"

echo "installed: $HOOKS_DIR/pre-commit"
echo "gate script (per worktree): scripts/sonar-precommit.sh"
echo
echo "Bypass one commit:   SKIP_SONAR=1 git commit …"
echo "                 or: git commit --no-verify"
echo "With coverage:       SONAR_WITH_COVERAGE=1 git commit …"
echo "Only when src/tests: SONAR_PRECOMMIT_STRICT_SRC=1 git commit …"
