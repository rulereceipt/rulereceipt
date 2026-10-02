#!/usr/bin/env bash
#
# validate-release.sh — the release gate. Packs the real tarball, installs it in a
# throwaway prefix, and runs the published CLI end-to-end the way a stranger would
# after `npx`. Nothing here imports from src/: it exercises the SHIPPED package, so
# a file left out of package.json "files" fails this and not a unit test.
#
# Reconstructed 2026-10-02 (the original reviewer script was never committed — see
# DECISIONS.md D1). Exits non-zero if any check fails; prints "N/M checks passed".
#
# Isolation: HOME is redirected to an empty temp dir so the machine's own
# ~/.claude/CLAUDE.md can't leak rules into the sample project.
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

PASS=0; TOTAL=0; FAILED=()
ok()   { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "  ok   · $1"; }
bad()  { TOTAL=$((TOTAL+1)); FAILED+=("$1"); echo "  FAIL · $1"; }
check(){ if eval "$2"; then ok "$1"; else bad "$1"; fi; }

WORK="$(mktemp -d)"
HOMEDIR="$(mktemp -d)"
trap 'rm -rf "$WORK" "$HOMEDIR"' EXIT
export HOME="$HOMEDIR"; export USERPROFILE="$HOMEDIR"; unset CLAUDE_CONFIG_DIR 2>/dev/null || true

echo "== build + pack =="
npm run build >/dev/null 2>&1 || { echo "build failed"; exit 1; }
PKG_VER="$(node -p "require('$REPO/package.json').version")"
TGZ="$(npm pack --silent 2>/dev/null | tail -1)"
[ -f "$REPO/$TGZ" ] || { echo "npm pack produced no tarball"; exit 1; }

echo "== install tarball in a clean prefix =="
mkdir -p "$WORK/app" && (cd "$WORK/app" && npm init -y >/dev/null 2>&1 && npm install "$REPO/$TGZ" >/dev/null 2>&1) \
  || { echo "tarball install failed"; exit 1; }
RR="$WORK/app/node_modules/.bin/rulereceipt"
[ -x "$RR" ] || { echo "installed package has no rulereceipt bin"; exit 1; }

# A sample project: one branch rule, a breaking session and a clean session.
PROJ="$WORK/proj"; mkdir -p "$PROJ"
printf '## 1. Branch\nNever push to the `main` branch directly.\n' > "$PROJ/CLAUDE.md"
printf '%s\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{"command":"git push origin main"}}]}}' > "$PROJ/fail.jsonl"
printf '%s\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{"command":"npm test"}}]}}' > "$PROJ/clean.jsonl"

run()  { (cd "$PROJ" && "$RR" "$@" 2>&1); }
code() { (cd "$PROJ" && "$RR" "$@" >/dev/null 2>&1); echo $?; }

echo "== checks =="
# 1. tag/version sanity
check "version: bin --version equals package.json ($PKG_VER)" '[ "$(run --version | tr -d "[:space:]")" = "$PKG_VER" ]'
# 2-3. the core promise: a real break exits 1 and reads as Broken; a clean run exits 0
BROKE="$(run check --transcript fail.jsonl)"
check "broken case: exit 1 on a proven break"            '[ "$(code check --transcript fail.jsonl)" = "1" ]'
check "broken case: report marks it broken"              'echo "$BROKE" | grep -qiE "broke|broken|✕|x  "'
check "broken case: quotes the offending command"        'echo "$BROKE" | grep -q "git push origin main"'
check "clean case: exit 0 when nothing was broken"        '[ "$(code check --transcript clean.jsonl)" = "0" ]'
# 4. the always-available surfaces must not crash
check "demo: exit 0, prints sample output"               '[ "$(code demo)" = "0" ] && run demo | grep -qi "sample output"'
check "selftest: exit 0"                                 '[ "$(code selftest)" = "0" ]'
check "audit: exit 0, lists the rule"                     '[ "$(code audit)" = "0" ]'
check "why: explains a matched rule"                      'run why "push to the main branch" | grep -qi "checkable\|loaded"'
check "why: shows how to block it (A3)"                   'run why "push to the main branch" | grep -q "permissions"'
# protect --undo and card legitimately exit 1 in a bare sample (nothing to undo /
# no discovered session) — that's a benign state, not a crash. Assert the command
# is reachable and gives its coherent message instead of demanding exit 0.
check "protect --undo: reachable, says nothing to undo"   'run protect --undo | grep -qi "nothing to undo"'
check "card: reachable, coherent no-session message"      'run card | grep -qi "card\|no sessions\|nothing to put"'
# 5. zero network on the default path: an unroutable proxy must not change the result
ZERONET="$(cd "$PROJ" && HTTPS_PROXY=http://127.0.0.1:9 HTTP_PROXY=http://127.0.0.1:9 ALL_PROXY=http://127.0.0.1:9 "$RR" check --transcript fail.jsonl 2>&1; echo "rc=$?")"
check "zero-network: plain check works with an unroutable proxy" 'echo "$ZERONET" | grep -q "rc=1" && echo "$ZERONET" | grep -q "git push origin main"'
# 6. no stack traces anywhere in the surfaces we ran
ALLOUT="$BROKE
$(run demo)
$(run audit)
$(run why "push to the main branch")
$(run --version)"
check "no-crash: no Node stack trace in any surface"      '! echo "$ALLOUT" | grep -qE "^[[:space:]]+at .+:[0-9]+:[0-9]+"'

echo ""
echo "== $PASS/$TOTAL checks passed =="
if [ "${#FAILED[@]}" -gt 0 ]; then
  printf '   failed: %s\n' "${FAILED[@]}"
  exit 1
fi
echo "   release gate GREEN for $PKG_VER"
