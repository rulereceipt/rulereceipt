#!/usr/bin/env bash
# Proves the test gate actually goes RED. It plants two kinds of failure that a
# green-looking summary could hide, and asserts the runner EXITS NON-ZERO for
# each. If either planted failure yields exit 0, THIS script fails — so the gate
# can never silently lose the ability to fail (global CLAUDE.md Rule 7).
#
# Case B reproduces the exact shape that masked a failure on 2026-10-07: a suite
# that throws at LOAD (fast-check's fc.char removed in v4) still printed
# "N passed" in the summary while the real signal was the non-zero exit code.
set -uo pipefail
cd "$(dirname "$0")/.."

DIR="tests/_gate_selftest"
cleanup() { rm -rf "$DIR"; }
trap cleanup EXIT
rm -rf "$DIR"; mkdir -p "$DIR"

# Case A — a failing assertion.
cat > "$DIR/assert.test.ts" <<'EOF'
import { it, expect } from "vitest";
it("planted failing assertion", () => { expect(1).toBe(2); });
EOF

# Case B — a suite that throws while being evaluated, before any test registers.
cat > "$DIR/loadfail.test.ts" <<'EOF'
import { it } from "vitest";
throw new Error("planted: suite fails to load");
it("never reached", () => {});
EOF

fail=0
for f in assert loadfail; do
  if npx vitest run "$DIR/$f.test.ts" >/dev/null 2>&1; then
    echo "   SELF-TEST BROKEN: planted '$f' did NOT make vitest exit non-zero"
    fail=1
  else
    echo "   ok · planted '$f' made vitest exit non-zero"
  fi
done

if [ "$fail" -ne 0 ]; then echo "GATE SELF-TEST FAILED"; exit 1; fi
echo "gate self-test OK — the runner goes red on planted failures"
