import { homedir } from "node:os";
import { dirname, join, parse } from "node:path";
import { existsSync } from "node:fs";
import { parseClaudeMd } from "./parsers/claudeMdParser.js";
import { findClaudeHomeDirNames } from "./parsers/transcriptParser.js";
import type { Rule } from "./types.js";

const RULE_FILE_NAMES = ["CLAUDE.md", "AGENTS.md"];

/**
 * Walks from the working directory up toward the repository root,
 * collecting rules files at every level.
 *
 * Real gap: rules were only read from the exact directory the command ran
 * in. Claude Code itself applies a rules file to everything beneath it, so
 * in a monorepo the root CLAUDE.md governs `packages/api/` — but running
 * the check inside that package silently missed it, reporting on a subset
 * of the rules that actually applied and never saying so.
 *
 * Stops at the repository root (a directory containing `.git`) so an
 * unrelated rules file further up the filesystem — in a parent workspace,
 * or the home directory — is never pulled into an unrelated project.
 * Global rules are handled separately, deliberately, below.
 */
function findProjectRuleFiles(cwd: string): string[] {
  const found: string[] = [];
  const { root } = parse(cwd);
  const home = homedir();
  let dir = cwd;

  for (;;) {
    for (const name of RULE_FILE_NAMES) {
      const p = join(dir, name);
      if (existsSync(p)) found.push(p);
    }
    // stop AT the repo root (inclusive) — its rules do apply
    if (existsSync(join(dir, ".git"))) break;
    if (dir === root || dir === home) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return found;
}

/**
 * Global rules come from every .claude*-prefixed home dir found, not just
 * ~/.claude — a hosted/enterprise Claude Code variant can keep its own
 * global CLAUDE.md under its own home dir (e.g. ~/.claude-office/CLAUDE.md).
 * Real gap found 2026-08-30, same root cause as the transcript-lookup fix
 * in transcriptParser.ts: hardcoding one home-dir name misses any variant.
 */
export function loadRules(cwd: string): Rule[] {
  const rules: Rule[] = findClaudeHomeDirNames().flatMap((dirName) =>
    parseClaudeMd(join(homedir(), dirName, "CLAUDE.md"), "global")
  );

  for (const path of findProjectRuleFiles(cwd)) {
    rules.push(...parseClaudeMd(path, "project"));
  }
  return rules;
}
