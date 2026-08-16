import type { Rule } from "../types.js";

/**
 * Day 1-2: read CLAUDE.md / AGENTS.md and split into individual rules.
 * Must survive real formatting, not just a clean example:
 * - numbered headings ("## 1. Title") with sub-bullets underneath
 * - both global (~/.claude/CLAUDE.md) and project-level files
 * - a rule's text continuing across multiple lines/bullets until the next heading
 */
export function parseClaudeMd(_filePath: string, _source: "global" | "project"): Rule[] {
  throw new Error("TODO: implement — start here Day 1");
}
