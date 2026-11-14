#!/usr/bin/env bash
# Gate step: run `claude plugin validate` on BOTH the marketplace and the plugin
# manifest, in --strict mode (warnings = failure). The plugin.test.ts +
# pluginVersion.test.ts suite checks the fields we rely on in every environment;
# this step is the authoritative manifest validation when the Claude Code CLI is
# present. If `claude` is not installed (e.g. a minimal CI image), it SKIPS with a
# notice rather than failing — the suite still covers the manifests.
set -uo pipefail
cd "$(dirname "$0")/.."

if ! command -v claude >/dev/null 2>&1; then
  echo "   skip · claude CLI not on PATH — manifest fields still covered by tests/plugin*.test.ts"
  exit 0
fi

rc=0
echo "   · validate marketplace (.claude-plugin/marketplace.json)"
claude plugin validate . --strict || rc=$?
echo "   · validate plugin (plugin/.claude-plugin/plugin.json)"
claude plugin validate ./plugin --strict || rc=$?
exit $rc
