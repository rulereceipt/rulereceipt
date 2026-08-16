import { readFileSync } from "node:fs";
import type { Rule } from "../types.js";

/**
 * Real CLAUDE.md files use "## N. Title" headers (H2, numbered) with the
 * rule body running until the next "## N." header or end of file. Verified
 * against a real 16-rule file — numbering is NOT guaranteed sequential
 * (real file skips from 11 to 13), so rule IDs must come from whatever
 * number actually appears, never assumed/generated.
 */
const RULE_HEADER = /^##\s+(\d+)\.\s+(.+)$/;

export function parseClaudeMd(filePath: string, source: "global" | "project"): Rule[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }

  const lines = raw.split("\n");
  const rules: Rule[] = [];
  let current: Rule | null = null;
  let bodyLines: string[] = [];

  const flush = () => {
    if (current) {
      current.text = bodyLines.join("\n").trim();
      rules.push(current);
    }
    bodyLines = [];
  };

  for (const line of lines) {
    const match = line.match(RULE_HEADER);
    if (match) {
      flush();
      current = { id: match[1], title: match[2].trim(), text: "", source };
    } else if (current) {
      bodyLines.push(line);
    }
  }
  flush();

  return rules;
}
