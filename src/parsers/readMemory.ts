import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { findClaudeHomeDirNames } from "./transcriptParser.js";
import type { Rule } from "../types.js";

/**
 * Claude Code's memory as a rule source.
 *
 * Memory lives per-project at:
 *   <claude-home>/projects/<cwd with every "/" -> "-">/memory/*.md
 * with an index `MEMORY.md` and one file per memory. Each file opens with a
 * frontmatter block:
 *   ---
 *   name: <slug>
 *   description: <one line>
 *   metadata:
 *     type: user | feedback | project | reference
 *   ---
 *   <body>
 *
 * Why this matters: teams increasingly move standing corrections into memory
 * ("after any correction, update memory"), so a rule the user actually holds
 * the agent to can live here and nowhere in CLAUDE.md. Without reading it the
 * tool goes stale — it reports a clean session while missing the very rule the
 * user cares most about.
 *
 * What counts as a rule: `feedback` (guidance on how to work — corrections and
 * confirmed approaches) and `project` (ongoing constraints) can carry
 * directives, so they are read. `user` (who the user is) and `reference`
 * (pointers/URLs) never are, and are skipped by type. Anything that slips
 * through and is not actually a directive is dropped downstream by the same
 * not-a-rule filter every rules file goes through — so a plain fact in memory
 * never becomes a checkable rule.
 *
 * Scope: non-office homes only. Reading office memory into this project is the
 * exact office/personal mixing this project forbids, so any `.claude*` home
 * whose name contains "office" is skipped.
 */

// Types whose memories can be rules. `user`/`reference` are excluded by
// omission; an untyped memory is kept and left to the not-a-rule filter.
const RULE_MEMORY_TYPES = new Set(["feedback", "project"]);

interface MemoryFront {
  type: string | null;
  name: string | null;
  description: string | null;
  body: string;
}

function parseMemoryFile(raw: string): MemoryFront {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { type: null, name: null, description: null, body: raw.trim() };
  const front = m[1];
  const body = m[2].trim();
  const type = front.match(/^\s*type:\s*(user|feedback|project|reference)\b/im)?.[1]?.toLowerCase() ?? null;
  const name = front.match(/^\s*name:\s*(.+)$/im)?.[1]?.trim() ?? null;
  const description = front.match(/^\s*description:\s*(.+)$/im)?.[1]?.trim() ?? null;
  return { type, name, description, body };
}

/**
 * The memory source for the load graph: the first existing non-office memory
 * dir for this project, and how many rules load from memory in total. Returns
 * null when memory contributes no rules. Lets `describeRuleSources` list memory
 * so the load graph matches what `loadRules` actually checks (memory was
 * omitted before — a reporting gap found 2026-10-03, not a checking gap).
 */
export function memoryGraphEntry(cwd: string): { path: string; ruleCount: number } | null {
  const ruleCount = loadMemoryRules(cwd).length;
  if (ruleCount === 0) return null;
  const encoded = cwd.replace(/\//g, "-");
  for (const dirName of findClaudeHomeDirNames()) {
    if (/office/i.test(dirName)) continue; // never office (project rule)
    const memoryDir = join(homedir(), dirName, "projects", encoded, "memory");
    try {
      if (statSync(memoryDir).isDirectory()) return { path: memoryDir, ruleCount };
    } catch {
      /* no memory dir under this home: try the next */
    }
  }
  return null;
}

export function loadMemoryRules(cwd: string): Rule[] {
  const rules: Rule[] = [];
  const seenIds = new Set<string>();
  const encoded = cwd.replace(/\//g, "-");

  for (const dirName of findClaudeHomeDirNames()) {
    if (/office/i.test(dirName)) continue; // never office (project rule)
    const memoryDir = join(homedir(), dirName, "projects", encoded, "memory");

    let files: string[];
    try {
      if (!statSync(memoryDir).isDirectory()) continue;
      files = readdirSync(memoryDir)
        .filter((f) => f.toLowerCase().endsWith(".md") && f !== "MEMORY.md")
        .sort();
    } catch {
      continue; // no memory dir for this project under this home: normal
    }

    for (const file of files) {
      let raw: string;
      try {
        raw = readFileSync(join(memoryDir, file), "utf-8");
      } catch {
        continue;
      }
      const { type, name, description, body } = parseMemoryFile(raw);
      // Skip identity/pointer memories by declared type; keep feedback/project
      // and untyped (the not-a-rule filter drops any non-directive body later).
      if (type !== null && !RULE_MEMORY_TYPES.has(type)) continue;
      if (!body) continue;

      const id = `memory:${name ?? basename(file, ".md")}`;
      if (seenIds.has(id)) continue; // same memory reachable from two homes
      seenIds.add(id);

      rules.push({
        id,
        title: description ?? name ?? basename(file, ".md"),
        text: body,
        source: "project",
      });
    }
  }

  return rules;
}
