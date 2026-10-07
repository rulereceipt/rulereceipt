#!/usr/bin/env bash
# The release gate. Every check passes or fails by its EXIT CODE — nothing here
# greps a tool's output to decide pass/fail. A masked failure (e.g. a suite that
# fails to LOAD while the summary still prints "N passed") cannot slip through,
# because we trust the exit code, not the text.
#
#   npm run gates
#
# Added 2026-10-07, after a hand-grep of `vitest run` output masked a failed
# suite. Gate 0 is the self-test that proves this gate can still go red.
set -uo pipefail
cd "$(dirname "$0")/.."

FAILED=()
run() { # run "<name>" <cmd...>
  local name="$1"; shift
  echo "── $name"
  if "$@"; then
    echo "   ok   · $name"
  else
    local rc=$?
    echo "   FAIL · $name (exit $rc)"
    FAILED+=("$name")
  fi
}

run "gate self-test (planted failures go red)" bash scripts/gate-selftest.sh
run "build"                     npm run build
run "typecheck"                 npm run typecheck
run "lint"                      npm run lint
run "unit + integration suite"  npm test
run "secretlint"                npm run secretlint
run "licence gate"              npm run license:check
run "false-accusation v1"       npx tsx scripts/false-accusation-rate.ts --frozen
run "false-accusation v2"       npx tsx scripts/false-accusation-rate.ts --frozen --v2
run "release tarball install"   bash scripts/validate-release.sh

echo ""
if [ "${#FAILED[@]}" -gt 0 ]; then
  printf 'GATES RED — %d failed:\n' "${#FAILED[@]}"
  printf '  - %s\n' "${FAILED[@]}"
  exit 1
fi
echo "ALL GATES GREEN"
