import { readFileSync } from "node:fs";
import { parseClaudeMdText } from "./claudeMdParser.js";
import type { Rule } from "../types.js";

/**
 * The filesystem half of rules-file parsing, deliberately kept in its own
 * module.
 *
 * claudeMdParser.ts must stay free of Node imports so it can be bundled
 * for the browser — the in-page checker on the site claims the pasted file
 * never leaves the page, and that is only true while nothing reachable
 * from the parser can perform I/O. Keeping the one readFileSync here
 * means a bundler cannot pull `node:fs` in behind it, and a future import
 * that breaks the guarantee has to be added here, visibly, rather than
 * appearing by accident in the parser.
 */
/**
 * Reads a rules file from disk. Thin wrapper: an unreadable file is an
 * empty rule list, never a throw, because a missing global CLAUDE.md is a
 * normal state rather than an error.
 */
/**
 * Strips a leading YAML frontmatter block (`---\n…\n---`) if present.
 *
 * Cursor's `.mdc` rule files open with a frontmatter block (description,
 * globs, alwaysApply) that is metadata, not a rule — without this it parses
 * as prose and surfaces `alwaysApply: true` as a checkable "rule". Kept in
 * the filesystem reader (not the browser parser) so the parser stays
 * Node-free. Only strips a block that starts on the very first line, so a
 * `---` divider mid-document is untouched.
 */
function stripFrontmatter(raw: string): string {
  if (!/^---\r?\n/.test(raw)) return raw;
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return raw;
  const after = raw.indexOf("\n", end + 1);
  return after === -1 ? "" : raw.slice(after + 1);
}

export function parseClaudeMd(filePath: string, source: "global" | "project"): Rule[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }
  return parseClaudeMdText(stripFrontmatter(raw), source);
}

