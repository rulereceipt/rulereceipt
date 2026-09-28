#!/usr/bin/env bash
# Cold-machine smoke: the exact commands a stranger runs after `npx`.
#
# The launch checklist requires this be green on a clean machine (or fresh
# container) against the EXACT version being advertised, on launch morning.
# It asserts only what must never break on a cold install: every command
# exits without a stack trace, and the two empty states say what to do next.
# It does NOT test correctness of a real check — that is the test suite's job.
#
# Usage:
#   scripts/smoke.sh                     # against the local built dist/cli.js
#   scripts/smoke.sh 0.1.60              # against npx rulereceipt@0.1.60
#   scripts/smoke.sh latest              # against npx rulereceipt@latest
#
# Exit 0 = safe to advertise that version. Any non-zero = do not launch on it.
set -u

if [ "${1:-}" = "" ]; then
  RUN=(node "$(cd "$(dirname "$0")/.." && pwd)/dist/cli.js")
  LABEL="local dist/cli.js"
else
  RUN=(npx --yes "rulereceipt@$1")
  LABEL="npx rulereceipt@$1"
fi

echo "smoke: $LABEL"
echo

# Isolate HOME so the machine's real global CLAUDE.md can't make an empty
# project look populated — the same reason the test suite isolates it.
HOME_ISO="$(mktemp -d)"
EMPTY="$(mktemp -d)"
WITHRULES="$(mktemp -d)"
printf '## 1. Never push to `main`\n- Always run `npm test`\n' > "$WITHRULES/CLAUDE.md"
trap 'rm -rf "$HOME_ISO" "$EMPTY" "$WITHRULES"' EXIT

fail=0

# run "<label>" <expected-exit> <cwd> -- <args...>
run() {
  local label="$1" want="$2" cwd="$3"; shift 3; [ "$1" = "--" ] && shift
  local out code
  out="$(cd "$cwd" && HOME="$HOME_ISO" USERPROFILE="$HOME_ISO" "${RUN[@]}" "$@" 2>&1)"
  code=$?
  if printf '%s\n' "$out" | grep -qE '^[[:space:]]+at[[:space:]]+.+:[0-9]+:[0-9]+'; then
    echo "FAIL  $label — stack trace in output"; fail=1; return
  fi
  if [ "$code" != "$want" ]; then
    echo "FAIL  $label — exit $code, wanted $want"; fail=1; return
  fi
  echo "ok    $label (exit $code)"
}

run "--version"                       0 "$EMPTY"     -- --version
run "--help"                          0 "$EMPTY"     -- --help
run "demo"                            0 "$EMPTY"     -- demo
run "audit (empty)"                   0 "$EMPTY"     -- audit
run "audit --json (empty)"            0 "$EMPTY"     -- audit --json
run "check (no rules, no session)"    0 "$EMPTY"     -- check
run "check --help"                    0 "$EMPTY"     -- check --help
run "audit (rules present)"           0 "$WITHRULES" -- audit
run "check (rules, no session)"       0 "$WITHRULES" -- check
run "check --require-session (none)"  1 "$WITHRULES" -- check --require-session

echo
if [ "$fail" = 0 ]; then
  echo "SMOKE PASS — safe to advertise $LABEL"
else
  echo "SMOKE FAIL — do NOT launch on $LABEL"
fi
exit "$fail"
