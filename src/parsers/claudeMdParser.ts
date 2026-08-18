import { readFileSync } from "node:fs";
import type { Rule } from "../types.js";

/**
 * Real CLAUDE.md/AGENTS.md files use several different conventions for
 * organizing rules. Verified against real files and templates: Anthropic's
 * own best-practices doc (plain "# Code style" / "# Workflow" headers with
 * bullets), the ~120k-star Karpathy/Forrest Chang template ("**Rule 1 —
 * Title**" bold pseudo-headers, no "#" at all), Builder.io's widely-shared
 * guide (plain "## Section" headers with bullets), and a real 16-rule
 * numbered file.
 *
 *  1. Numbered headers: "## 3. Title" (any header level 1-6). One rule per
 *     header; body runs until the next rule-start line. Numbering is NOT
 *     guaranteed sequential (a real file skips a number), so the rule ID
 *     always comes from whatever number actually appears, never generated.
 *  2. Bold pseudo-headers: "**Rule 3 — Title**" with no "#" at all. Same
 *     one-rule-per-marker behavior as (1).
 *  3. Plain (unnumbered) headers used as section labels, e.g. "## Code
 *     Style". Bullet items under a plain header are independent, atomic
 *     rules, so each becomes its own rule (id "S<section>.<bullet>") — this
 *     is the dominant real-world pattern. Prose directly under a plain
 *     header (no bullets) becomes a single rule for that section instead.
 *     The "S" prefix keeps these ids from ever colliding with, or reading
 *     as a sub-item of, a numbered-header/bold-rule id (always a bare
 *     digit string).
 *  4. Bullets with no preceding header at all belong to implicit section
 *     "S0".
 *  5. Setext-style headers ("Title\n===" for H1, "Title\n---" for H2) —
 *     a real, if less common, Markdown convention. Normalized to the ATX
 *     form ("# Title") before the main pass below, so they flow through
 *     the same numbered/plain-header detectors rather than needing a
 *     separate code path. Only fires when the line above the underline
 *     is real title text (non-blank, not already a header/bullet/rule
 *     line) — a bare "---" on its own (a thematic-break divider) is left
 *     alone, since a real underline is always glued directly under text.
 *  6. Last resort: a file with none of the above (freeform prose, no
 *     headers, no bullets, no bold-rule markers) is split one rule per
 *     blank-line-separated paragraph, so a genuinely unstructured file
 *     still yields checkable rules instead of silently returning nothing.
 */
const NUMBERED_HEADER = /^#{1,6}\s+(\d+)\.\s+(.+)$/;
const BOLD_RULE_HEADER = /^\*\*Rule\s+(\d+)\s*[-–—:]\s*(.+?)\*\*\s*$/i;
const PLAIN_HEADER = /^#{1,6}\s+(.+)$/;
const BULLET_ITEM = /^\s*[-*+]\s+(.+)$/;
const SETEXT_H1_UNDERLINE = /^=+\s*$/;
const SETEXT_H2_UNDERLINE = /^-{2,}\s*$/;

function normalizeSetextHeaders(lines: string[]): string[] {
  const out = [...lines];
  for (let i = 0; i < out.length - 1; i++) {
    const title = out[i];
    if (title.trim() === "") continue;
    if (
      NUMBERED_HEADER.test(title) ||
      BOLD_RULE_HEADER.test(title) ||
      PLAIN_HEADER.test(title) ||
      BULLET_ITEM.test(title)
    ) {
      continue;
    }
    const underline = out[i + 1];
    if (SETEXT_H1_UNDERLINE.test(underline)) {
      out[i] = `# ${title.trim()}`;
      out[i + 1] = "";
    } else if (SETEXT_H2_UNDERLINE.test(underline)) {
      out[i] = `## ${title.trim()}`;
      out[i + 1] = "";
    }
  }
  return out;
}

export function parseClaudeMd(filePath: string, source: "global" | "project"): Rule[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }

  const lines = normalizeSetextHeaders(raw.split("\n"));
  const rules: Rule[] = [];

  // `current` accumulates a numbered-header rule, a bold-rule-header rule,
  // or a plain-section prose rule. Bullet items under a plain section are
  // emitted immediately as their own rules and never touch `current`, so
  // prose before/after a bullet list in the same section still merges into
  // one section-level rule.
  //
  // Plain-header-derived ids are always prefixed "S" ("S<section>.0" for
  // whole-section prose or "S<section>.<bullet>" per bullet), so they can
  // never collide with OR be visually mistaken for a numbered-header/bold-
  // rule id, which is always a bare digit string — a report listing rule
  // "1" next to rule "S1.1" reads unambiguously as two unrelated rules,
  // where "1" next to "1.1" could misread as parent/child. `sectionId` is
  // assigned lazily, on the first rule a section actually produces, so a
  // header with no content under it (e.g. a file's leading "# Project: ..."
  // title line) doesn't burn a section number that real sections would
  // otherwise expect.
  let current: Rule | null = null;
  let currentIsMarkedRule = false; // true for numbered/bold rules: bullets in their body stay as body text
  let bodyLines: string[] = [];
  let pendingSectionTitle: string | null = null;
  let sectionCount = 0;
  let sectionId: string | null = "S0"; // "S0" before any header is seen; null while a header is pending its first rule
  let bulletIndex = 0;

  const flush = () => {
    if (current) {
      current.text = bodyLines.join("\n").trim();
      rules.push(current);
    }
    current = null;
    bodyLines = [];
  };

  const assignSectionId = () => {
    if (sectionId === null) {
      sectionCount += 1;
      sectionId = `S${sectionCount}`;
    }
    return sectionId;
  };

  for (const line of lines) {
    const numbered = line.match(NUMBERED_HEADER);
    if (numbered) {
      flush();
      pendingSectionTitle = null;
      current = { id: numbered[1], title: numbered[2].trim(), text: "", source };
      currentIsMarkedRule = true;
      continue;
    }

    const bold = line.match(BOLD_RULE_HEADER);
    if (bold) {
      flush();
      pendingSectionTitle = null;
      current = { id: bold[1], title: bold[2].trim(), text: "", source };
      currentIsMarkedRule = true;
      continue;
    }

    const plain = line.match(PLAIN_HEADER);
    if (plain) {
      flush();
      sectionId = null;
      bulletIndex = 0;
      pendingSectionTitle = plain[1].trim();
      currentIsMarkedRule = false;
      continue;
    }

    const bullet = line.match(BULLET_ITEM);
    if (bullet) {
      if (currentIsMarkedRule) {
        bodyLines.push(line);
      } else {
        bulletIndex += 1;
        const text = bullet[1].trim();
        rules.push({ id: `${assignSectionId()}.${bulletIndex}`, title: text, text, source });
      }
      continue;
    }

    if (currentIsMarkedRule) {
      bodyLines.push(line);
    } else if (pendingSectionTitle !== null && line.trim() !== "") {
      current = { id: `${assignSectionId()}.0`, title: pendingSectionTitle, text: "", source };
      bodyLines = [line];
      pendingSectionTitle = null;
    } else if (current) {
      bodyLines.push(line);
    }
  }
  flush();

  if (rules.length > 0) {
    return rules;
  }

  // Last resort: a file with none of the above (freeform prose, no
  // headers, no bullets, no bold-rule markers) is split one rule per
  // blank-line-separated paragraph, so a genuinely unstructured file
  // still yields checkable rules instead of silently returning nothing.
  const paragraphs = raw
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  return paragraphs.map((p, i) => {
    const firstLine = p.split("\n")[0].trim();
    const title = firstLine.length > 100 ? `${firstLine.slice(0, 100).trim()}…` : firstLine;
    return { id: String(i + 1), title, text: p, source };
  });
}
