import { homedir } from "node:os";
import { dirname, join, parse } from "node:path";
import { existsSync, readdirSync, statSync } from "node:fs";
import { parseClaudeMd } from "./parsers/readClaudeMd.js";
import { findClaudeHomeDirNames } from "./parsers/transcriptParser.js";
import type { Rule } from "./types.js";

/**
 * Every place Claude Code actually reads a rule from, at one directory
 * level. Order mirrors the documented load order, broadest first.
 *
 * Real gap found 2026-09-02: only the two bare filenames were read. A
 * project with four rules files reported "1 rules checked · all passed" —
 * three files invisible, with nothing saying so. A clean report on rules
 * the tool never opened is the most misleading result this can produce,
 * worse than no report, because it looks like evidence.
 */
const RULE_FILE_NAMES = ["CLAUDE.md", "AGENTS.md", "CLAUDE.local.md", "AGENTS.local.md"];
const RULE_SUBDIR_FILES = [join(".claude", "CLAUDE.md"), join(".claude", "AGENTS.md")];
const RULE_DIRS = [join(".claude", "rules")];

/**
 * Lists the markdown files in a rules directory, if it exists.
 *
 * Sorted so the same project always produces the same rule order — rule
 * ids are positional, and an unstable order would renumber rules between
 * runs on different machines, making two reports of the same session
 * impossible to compare. Non-markdown files are skipped: a rules
 * directory legitimately holds README fragments and notes.
 */
function markdownFilesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    if (!statSync(dir).isDirectory()) return [];
    return readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith(".md"))
      .sort()
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

/** Every rules file at one directory level, in documented load order. */
function ruleFilesAtLevel(dir: string): string[] {
  const found: string[] = [];
  for (const rel of RULE_SUBDIR_FILES) {
    const p = join(dir, rel);
    if (existsSync(p)) found.push(p);
  }
  for (const rel of RULE_DIRS) found.push(...markdownFilesIn(join(dir, rel)));
  for (const name of RULE_FILE_NAMES) {
    const p = join(dir, name);
    if (existsSync(p)) found.push(p);
  }
  return found;
}

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
    found.push(...ruleFilesAtLevel(dir));
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
 *
 * Also reads ~/.claude/rules/*.md, the documented location for personal
 * rules that apply across every project.
 *
 * NOT covered, and stated rather than left silent: machine-wide managed
 * enterprise policy files (/Library/Application Support/ClaudeCode,
 * /etc/claude-code, C:\Program Files\ClaudeCode). Those are deployed by
 * IT, exist on no development machine this can be tested against, and
 * guessing at their location would be the kind of unverified assumption
 * this project has already been bitten by twice.
 */
export function loadRules(cwd: string): Rule[] {
  const rules: Rule[] = [];

  for (const dirName of findClaudeHomeDirNames()) {
    const base = join(homedir(), dirName);
    rules.push(...parseClaudeMd(join(base, "CLAUDE.md"), "global"));
    for (const file of markdownFilesIn(join(base, "rules"))) {
      rules.push(...parseClaudeMd(file, "global"));
    }
  }

  for (const path of findProjectRuleFiles(cwd)) {
    rules.push(...parseClaudeMd(path, "project"));
  }
  return rules;
}
