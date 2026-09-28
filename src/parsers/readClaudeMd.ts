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

/**
 * Reads the path scope out of a leading frontmatter block, if it has one.
 *
 * Shapes seen in 343 real rule files (2026-09-28): `paths:` as a YAML list
 * or inline array (Claude Code), `globs:` as inline array, comma list, bare
 * scalar or YAML list (Cursor, agy). `alwaysApply: true` (Cursor) and
 * `trigger: always_on` (agy) mean the file is always loaded whatever its
 * globs say, so they clear the scope. Anything unreadable returns undefined,
 * which means "always loaded": the pre-existing behaviour.
 */
export function readPathScope(raw: string): string[] | undefined {
  if (!/^---\r?\n/.test(raw)) return undefined;
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return undefined;
  const lines = raw.slice(raw.indexOf("\n") + 1, end).split(/\r?\n/);
  if (lines.some((l) => /^alwaysApply:\s*true\b/i.test(l) || /^trigger:\s*always_on\b/i.test(l))) return undefined;

  const unquote = (v: string) => v.trim().replace(/^["']|["']$/g, "").trim();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(paths|globs):\s*(.*)$/);
    if (!m) continue;
    const value = m[2].trim();
    let items: string[] = [];
    if (value.startsWith("[")) {
      items = value.replace(/^\[|\]$/g, "").split(",").map(unquote);
    } else if (value.length > 0) {
      items = value.split(",").map(unquote);
    } else {
      for (let j = i + 1; j < lines.length && /^\s*-\s+/.test(lines[j]); j++) {
        items.push(unquote(lines[j].replace(/^\s*-\s+/, "")));
      }
    }
    items = items.filter((x) => x.length > 0);
    // `**/*` or `*` scopes to everything: same as no scope.
    if (items.length === 0 || items.some((x) => x === "**/*" || x === "**" || x === "*")) return undefined;
    return items;
  }
  return undefined;
}

export function parseClaudeMd(filePath: string, source: "global" | "project"): Rule[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }
  const rules = parseClaudeMdText(stripFrontmatter(raw), source);
  const paths = readPathScope(raw);
  return paths ? rules.map((r) => ({ ...r, paths })) : rules;
}

