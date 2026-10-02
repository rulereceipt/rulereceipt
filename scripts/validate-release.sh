#!/usr/bin/env bash
#
# validate-release.sh — the release gate. Packs the real tarball, installs it in a
# throwaway prefix, and exercises the SHIPPED CLI the way a stranger would after
# `npx` — so a file dropped from package.json "files" fails this, not a unit test.
#
# Reconstructed 2026-10-02 (the original reviewer script was never committed, see
# DECISIONS.md D1) and expanded 2026-10-02 to restore the original's coverage:
# a planted violation for EACH structured checker (A–F), session discovery for
# dotted/underscore/space paths and monorepos, the PreToolUse guard (incl a
# chained-heredoc push), protect apply+undo, @import loading, cold-start smoke
# states, zero-network and a no-stack-trace scan.
#
# HOME is redirected to an empty temp dir so the machine's own ~/.claude can't
# leak rules or sessions into the fixtures. Exits non-zero if any check fails.
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"
PASS=0; TOTAL=0; FAILED=()
ok()   { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "  ok   · $1"; }
bad()  { TOTAL=$((TOTAL+1)); FAILED+=("$1"); echo "  FAIL · $1"; }
check(){ if eval "$2"; then ok "$1"; else bad "$1"; fi; }

WORK="$(mktemp -d)"; HOMEDIR="$(mktemp -d)"
trap 'rm -rf "$WORK" "$HOMEDIR"' EXIT
export HOME="$HOMEDIR"; export USERPROFILE="$HOMEDIR"; unset CLAUDE_CONFIG_DIR 2>/dev/null || true

echo "== build + pack =="
npm run build >/dev/null 2>&1 || { echo "build failed"; exit 1; }
PKG_VER="$(node -p "require('$REPO/package.json').version")"
TGZ="$(npm pack --silent 2>/dev/null | tail -1)"
[ -f "$REPO/$TGZ" ] || { echo "npm pack produced no tarball"; exit 1; }
mkdir -p "$WORK/app" && (cd "$WORK/app" && npm init -y >/dev/null 2>&1 && npm install "$REPO/$TGZ" >/dev/null 2>&1) || { echo "tarball install failed"; exit 1; }
RR="$WORK/app/node_modules/.bin/rulereceipt"
[ -x "$RR" ] || { echo "installed package has no rulereceipt bin"; exit 1; }

# --- fixture helpers -------------------------------------------------------
# A JSONL line for an assistant Bash command, a Write, a tool_result, or text.
jbash(){ printf '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"%s","name":"Bash","input":{"command":%s}}]}}\n' "${2:-c1}" "$(node -p 'JSON.stringify(process.argv[1])' "$1")"; }
jwrite(){ printf '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Write","input":{"file_path":%s,"content":%s}}]}}\n' "$(node -p 'JSON.stringify(process.argv[1])' "$1")" "$(node -p 'JSON.stringify(process.argv[1])' "$2")"; }
jresult(){ printf '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"%s","content":%s,"is_error":%s}]}}\n' "$1" "$(node -p 'JSON.stringify(process.argv[1])' "$2")" "$3"; }
jtext(){ printf '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":%s}]}}\n' "$(node -p 'JSON.stringify(process.argv[1])' "$1")"; }
newproj(){ local d="$WORK/$1"; mkdir -p "$d"; printf '%b' "$2" > "$d/CLAUDE.md"; echo "$d"; }
rc(){ (cd "$1" && shift && "$RR" "$@" >/dev/null 2>&1); echo $?; }
out(){ (cd "$1" && shift && "$RR" "$@" 2>&1); }

echo "== version =="
check "version: bin --version equals package.json ($PKG_VER)" '[ "$(out "$WORK/app" --version | tr -d "[:space:]")" = "$PKG_VER" ]'

echo "== A-F: a planted violation for each structured checker =="
# A. git branch policy
PB="$(newproj pb '## 1. Branch\nNever push to the `main` branch directly.\n')"
jbash "git push origin main" > "$PB/s.jsonl"; jbash "npm test" > "$PB/clean.jsonl"
B="$(out "$PB" check --transcript s.jsonl)"
check "A gitBranchPolicy: push to main is Broken"        'echo "$B" | grep -qiE "broke|broken|✕"'
check "A gitBranchPolicy: exit 1"                        '[ "$(rc "$PB" check --transcript s.jsonl)" = "1" ]'
check "A gitBranchPolicy: quotes the command"            'echo "$B" | grep -q "git push origin main"'
check "A gitBranchPolicy: clean session exits 0"         '[ "$(rc "$PB" check --transcript clean.jsonl)" = "0" ]'
# B. file lifecycle
PE="$(newproj pe '## 1. Secrets\nNever modify `.env`.\n')"; jwrite ".env" "SECRET=x" > "$PE/s.jsonl"
check "B fileLifecycle: editing .env is Broken"          'out "$PE" check --transcript s.jsonl | grep -qiE "broke|broken|✕"'
# C. code content
PC="$(newproj pc '## 1. Logging\nNever leave a `console.log(` call in committed code.\n')"; jwrite "a.ts" "console.log(1)" > "$PC/s.jsonl"
check "C codeContent: a console.log( write is Broken"    'out "$PC" check --transcript s.jsonl | grep -qiE "broke|broken|✕"'
# D. claim vs evidence (fake "tests pass")
PCL="$(newproj pcl '## 1. Evidence\nNever claim the tests pass unless you have proof they actually passed.\n')"
{ jbash "npm test" t1; jresult t1 "Tests: 2 failed" true; jtext "All tests pass now."; } > "$PCL/s.jsonl"
check "D claimEvidence: a false tests-pass claim is Broken" 'out "$PCL" check --transcript s.jsonl | grep -qiE "broke|broken|✕"'
# E. attribution trailer
PA="$(newproj pa '## 1. No AI trace\nNever add a `Co-Authored-By: Claude` trailer to a git commit.\n')"
jbash "git commit -m \$'fix\n\nCo-Authored-By: Claude <noreply@anthropic.com>'" > "$PA/s.jsonl"
check "E attribution: a Co-Authored-By commit is Broken" 'out "$PA" check --transcript s.jsonl | grep -qiE "broke|broken|✕"'
# F. approval gate — reachable, reported (Broken only in no-prompt modes, so here can't-tell)
PG="$(newproj pg '## 1. Push\nNever push without the user explicit approval.\n')"; jbash "git push origin main" > "$PG/s.jsonl"
check "F approvalGate: rule is checked, no crash"        'out "$PG" check --transcript s.jsonl | grep -qiE "approval|push|rules checked|broke|judgment|can.t tell|unclear"'

echo "== @import: imported AGENTS.md rules are enforced =="
PI="$(newproj pi '@AGENTS.md\n')"; printf '## 1. Branch\nNever push to the `main` branch directly.\n' > "$PI/AGENTS.md"
jbash "git push origin main" > "$PI/s.jsonl"
check "@import: imported branch rule fires (Broken)"     'out "$PI" check --transcript s.jsonl | grep -qiE "broke|broken|✕"'

echo "== session discovery (no --transcript) =="
# dotted/underscore/space project path, session matched by stored cwd
PD="$WORK/my.proj_v2 beta"; mkdir -p "$PD"; printf '## 1. Branch\nNever push to `main`.\n' > "$PD/CLAUDE.md"
PDREAL="$(cd "$PD" && pwd -P)"
SDIR="$HOMEDIR/.claude/projects/encoded-xyz"; mkdir -p "$SDIR"
printf '{"type":"user","cwd":"%s","message":{"role":"user","content":"hi"}}\n' "$PDREAL" > "$SDIR/sess.jsonl"
jbash "git push origin main" >> "$SDIR/sess.jsonl"
check "discovery: dotted/underscore/space path finds the session" '! out "$PD" check | grep -qiE "no sessions found|no coding-agent session"'
# monorepo: session cwd is a subfolder; found from the repo root
PM="$WORK/mono"; mkdir -p "$PM/.git" "$PM/packages/api"; printf '## 1. Branch\nNever push to `main`.\n' > "$PM/CLAUDE.md"
SDIR2="$HOMEDIR/.claude/projects/mono-enc"; mkdir -p "$SDIR2"
printf '{"type":"user","cwd":"%s/packages/api","message":{"role":"user","content":"hi"}}\n' "$(cd "$PM" && pwd -P)" > "$SDIR2/sess.jsonl"
jbash "npm test" >> "$SDIR2/sess.jsonl"
check "discovery: monorepo subfolder session found from repo root" '! out "$PM" check | grep -qiE "no sessions found|no coding-agent session"'

echo "== guard (PreToolUse over stdin) =="
guard(){ printf '%s' "$1" | (cd "$2" && "$RR" guard 2>&1); }
GP='{"cwd":"'"$PB"'","tool_name":"Bash","tool_input":{"command":"git push origin main"},"permission_mode":"bypassPermissions"}'
check "guard: denies a push to main"                     'guard "$GP" "$PB" | grep -q "\"permissionDecision\":\"deny\""'
GA='{"cwd":"'"$PB"'","tool_name":"Bash","tool_input":{"command":"ls -la"}}'
check "guard: allows a benign ls"                        '[ "$(guard "$GA" "$PB")" = "{}" ]'
GH='{"cwd":"'"$PB"'","tool_input":{"command":"cat <<'"'"'EOF'"'"' > n.txt\nhi\nEOF\ngit push origin main"},"tool_name":"Bash","permission_mode":"bypassPermissions"}'
check "guard: denies a push chained after a heredoc"     'guard "$GH" "$PB" | grep -q "\"permissionDecision\":\"deny\""'

echo "== protect apply + undo =="
PP="$(newproj pp '## 1. Branch\nNever push to `main`.\n')"
APPLY="$(printf 'y\n' | (cd "$PP" && "$RR" protect 2>&1))"
check "protect: apply writes the guard hook (or shows it)" '[ -f "$PP/.claude/settings.json" ] && grep -q "rulereceipt guard" "$PP/.claude/settings.json" || echo "$APPLY" | grep -qiE "guard|PreToolUse"'
check "protect --undo: reachable"                        'out "$PP" protect --undo | grep -qiE "restored|nothing to undo"'

echo "== cold-start smoke (no crashes) =="
EMPTY="$WORK/empty"; mkdir -p "$EMPTY"
check "audit empty: exit 0, says where rules go"         '[ "$(rc "$EMPTY" audit)" = "0" ] && out "$EMPTY" audit | grep -qi "no rules file found"'
check "audit --json empty: valid zero JSON"              'out "$EMPTY" audit --json | node -e "let s=\"\";process.stdin.on(\"data\",d=>s+=d).on(\"end\",()=>{const j=JSON.parse(s);process.exit(j.total===0?0:1)})"'
check "check no rules/session: exit 0, names next step"  '[ "$(rc "$EMPTY" check)" = "0" ]'
check "check --require-session no session: exit 1"       '[ "$(rc "$PB" check --require-session --transcript /nope.jsonl)" = "1" ] || [ "$(rc "$EMPTY" check --require-session)" = "1" ]'
check "demo: exit 0, sample output"                      '[ "$(rc "$EMPTY" demo)" = "0" ] && out "$EMPTY" demo | grep -qi "sample output"'
check "selftest: exit 0"                                 '[ "$(rc "$EMPTY" selftest)" = "0" ]'

echo "== surfaces =="
check "why: explains a matched rule"                     'out "$PB" why "push to the main branch" | grep -qiE "checkable|loaded"'
check "why: shows how to block it (A3)"                  'out "$PB" why "push to the main branch" | grep -q "permissions"'
check "why --all: lists rules"                           'out "$PB" why --all | grep -qiE "branch|rule"'
check "card: reachable, coherent message"                'out "$PB" card | grep -qiE "card|no sessions|nothing to put"'
check "check --json: valid JSON"                         'out "$PB" check --transcript s.jsonl --json | node -e "let s=\"\";process.stdin.on(\"data\",d=>s+=d).on(\"end\",()=>{JSON.parse(s);process.exit(0)})"'
check "exit-zero: a break reports but exits 0"           '[ "$(rc "$PB" check --transcript s.jsonl --exit-zero)" = "0" ]'

echo "== zero-network =="
ZN="$(cd "$PB" && HTTPS_PROXY=http://127.0.0.1:9 HTTP_PROXY=http://127.0.0.1:9 ALL_PROXY=http://127.0.0.1:9 "$RR" check --transcript s.jsonl 2>&1; echo rc=$?)"
check "zero-network: plain check works with an unroutable proxy" 'echo "$ZN" | grep -q "rc=1" && echo "$ZN" | grep -q "git push origin main"'
ZG="$(printf '%s' "$GP" | (cd "$PB" && HTTPS_PROXY=http://127.0.0.1:9 ALL_PROXY=http://127.0.0.1:9 "$RR" guard 2>&1))"
check "zero-network: guard denies with an unroutable proxy" 'echo "$ZG" | grep -q "deny"'

echo "== dogfood: false passes must not read as 'followed'; examples aren't rules =="
PFP="$(newproj pfp '## 1. Release\nAlways run `git tag` when cutting a release.\n')"
jwrite "NOTES.md" "remember to run git tag v1.0.0 before the release" > "$PFP/wrote.jsonl"
jbash "git tag v1.0.0" > "$PFP/ran.jsonl"
check "false-pass: writing the command text into a file is NOT 'followed'" 'out "$PFP" check --transcript wrote.jsonl | grep -q "0 followed"'
check "true-pass: actually running the command IS 'followed'"             'out "$PFP" check --transcript ran.jsonl | grep -q "1 followed"'
PEX="$(newproj pex '## 1. Commits\nNever commit to `main`.\n\n## Example commit messages\n- feat: add the login page\n- fix: header spacing\n')"
check "examples: sample bullets under an Examples heading are NOT rules" '! out "$PEX" audit | grep -q "feat: add the login page"'

echo "== team preview (export is masked, no transcript; team merges to a snapshot) =="
PT="$(newproj pt '## 1. Branch\nNever push to the `main` branch directly.\n')"
jbash "git push origin main" > "$PT/s.jsonl"
TEAMDIR="$WORK/teamdir"; mkdir -p "$TEAMDIR"
(cd "$PT" && "$RR" check --transcript s.jsonl --export "$TEAMDIR/ada.json" --dev Ada >/dev/null 2>&1)
check "export: written, no absolute path leaked"      '[ -f "$TEAMDIR/ada.json" ] && ! grep -q "$PT" "$TEAMDIR/ada.json"'
check "export: carries the verdict + quoted evidence"  'grep -q "git push origin main" "$TEAMDIR/ada.json" && grep -q "\"status\": \"FAIL\"" "$TEAMDIR/ada.json"'
(cd "$PT" && "$RR" team "$TEAMDIR" >/dev/null 2>&1)
check "team: merges exports into an HTML snapshot"     '[ -f "$TEAMDIR/team-report.html" ] && grep -q "team preview" "$TEAMDIR/team-report.html"'
check "team: public snapshot has NO over-time trend"   '! grep -q "Breaks by day" "$TEAMDIR/team-report.html"'

echo "== no stack traces =="
ALL="$B
$(out "$PE" check --transcript s.jsonl)
$(out "$EMPTY" audit)
$(out "$EMPTY" demo)
$(out "$PB" why --all)"
check "no-crash: no Node stack trace in any surface"     '! echo "$ALL" | grep -qE "^[[:space:]]+at .+:[0-9]+:[0-9]+"'

echo ""
echo "== $PASS/$TOTAL checks passed =="
if [ "${#FAILED[@]}" -gt 0 ]; then
  printf '   failed: %s\n' "${FAILED[@]}"
  exit 1
fi
echo "   release gate GREEN for $PKG_VER"
