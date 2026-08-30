import { homedir } from "node:os";
import { join } from "node:path";
import { parseClaudeMd } from "./parsers/claudeMdParser.js";
import { findClaudeHomeDirNames } from "./parsers/transcriptParser.js";
import type { Rule } from "./types.js";

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

  for (const name of ["CLAUDE.md", "AGENTS.md"]) {
    const projectPath = join(cwd, name);
    rules.push(...parseClaudeMd(projectPath, "project"));
  }
  return rules;
}
