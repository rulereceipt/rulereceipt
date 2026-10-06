#!/usr/bin/env node
/**
 * Installs the tracked .githooks/pre-commit into .git/hooks/pre-commit so the
 * secretlint scan runs at commit time. Runs from the `prepare` script on
 * `npm install` (contributors only — `prepare` does not run for consumers who
 * install the published tarball). Copies into .git/hooks (does NOT set
 * core.hooksPath) so it coexists with the `protect --git` pre-push hook.
 *
 * Never throws: a failure here must not break `npm install`. No-ops when there
 * is no .git (e.g. a tarball install, or CI without a working tree).
 */
import { existsSync, readFileSync, writeFileSync, statSync, chmodSync, mkdirSync } from "node:fs";
import { join, isAbsolute, resolve, dirname } from "node:path";

try {
  const dotGit = join(process.cwd(), ".git");
  let gitDir = dotGit;
  // Act-then-handle: statSync throws (caught below) if there is no .git — a
  // tarball install or non-repo — avoiding an existsSync-then-stat race.
  if (statSync(dotGit).isFile()) {
    const m = readFileSync(dotGit, "utf-8").match(/gitdir:\s*(.+)\s*/);
    if (!m) process.exit(0);
    gitDir = isAbsolute(m[1]) ? m[1] : resolve(process.cwd(), m[1]);
  }
  const src = join(process.cwd(), ".githooks", "pre-commit");
  if (!existsSync(src)) process.exit(0);
  const dest = join(gitDir, "hooks", "pre-commit");
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, readFileSync(src, "utf-8"));
  chmodSync(dest, 0o755);
} catch {
  /* never break install */
}
process.exit(0);
