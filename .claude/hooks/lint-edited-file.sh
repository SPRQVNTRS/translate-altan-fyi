#!/usr/bin/env bash
#
# PostToolUse hook: lint the file that was just written or edited.
#
# The point is feedback latency. Without this, an anti-slop violation survives
# until `pnpm lint` runs — by which time the assistant has usually moved on and
# the fix is a context reload. Linting the single edited file costs ~30ms and
# puts the finding in front of the model while it still has the file in mind.
#
# Exit code 2 is the Claude Code convention for "block and show stderr to the
# model", which is what turns this from a log line into a correction.

set -uo pipefail

cd "$CLAUDE_PROJECT_DIR" || exit 0

file=$(jq -r '.tool_input.file_path // empty' 2>/dev/null)
[ -z "$file" ] && exit 0

case "$file" in
  *.ts | *.tsx | *.js | *.jsx | *.mjs | *.cjs) ;;
  *) exit 0 ;;
esac

[ -f "$file" ] || exit 0

# Vendored upstream code is excluded in .oxlintrc.json; skip the spawn entirely.
case "$file" in
  */tools/oxlint/anti-slop/* | tools/oxlint/anti-slop/*) exit 0 ;;
esac

if ! output=$(pnpm exec oxlint --max-warnings 0 "$file" 2>&1); then
  {
    echo "oxlint found issues in ${file#"$CLAUDE_PROJECT_DIR"/}:"
    echo
    echo "$output"
    echo
    echo "Fix the code — do not downgrade a rule or add a suppression comment."
    echo "Rule-by-rule guidance: AGENTS.md § Linting."
  } >&2
  exit 2
fi

exit 0
