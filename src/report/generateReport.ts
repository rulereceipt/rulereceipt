import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { CheckResult } from "../types.js";

export interface ReportMeta {
  sessionFilePath: string | null;
  ruleCount: number;
}

const MARK: Record<CheckResult["status"], string> = { PASS: "✓", FAIL: "✕", UNCLEAR: "?" };

/**
 * A CLAUDE.md rule title, or evidence text pulled from session content, is
 * untrusted — a malicious/compromised CLAUDE.md (e.g. from a cloned repo)
 * could embed raw ANSI escape codes to spoof what the terminal displays
 * (fake colors, cursor tricks, hidden lines), directly undermining a tool
 * whose whole point is a trustworthy terminal report. Strip C0/C1 control
 * characters (keep \n — real multi-line evidence stays readable) before
 * anything untrusted reaches the terminal. Found by security audit.
 */
function stripControlChars(s: string): string {
  return s.replace(/[\x00-\x09\x0B-\x1F\x7F-\x9F]/g, "");
}

function sanitize(r: CheckResult): CheckResult {
  return { ...r, ruleTitle: stripControlChars(r.ruleTitle), evidence: stripControlChars(r.evidence) };
}

/**
 * SHA-256 of the raw session file bytes — not a derived/normalized
 * representation, so anyone with the same file can trivially reproduce
 * the exact same hash and confirm the report matches a real, unaltered
 * session. Returns null (not a throw) if there's no session file, which
 * is a valid state (e.g. running against demo data).
 */
export function computeTranscriptHash(sessionFilePath: string | null): string | null {
  if (!sessionFilePath) return null;
  try {
    const raw = readFileSync(sessionFilePath);
    return createHash("sha256").update(raw).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Global and project-level CLAUDE.md can legitimately reuse the same
 * rule number (real, tested case) — only label the source when there's
 * an actual collision, so the common case stays clean ("Rule 1"), and
 * the rare case stays correct ("Rule 1 (global)" / "Rule 1 (project)").
 */
function ruleLabel(r: CheckResult, results: CheckResult[]): string {
  const collides = results.filter((other) => other.ruleId === r.ruleId).length > 1;
  return collides ? `Rule ${r.ruleId} (${r.ruleSource}) — ${r.ruleTitle}` : `Rule ${r.ruleId} — ${r.ruleTitle}`;
}

/**
 * Separates the two very different things that were both being reported
 * as "unclear":
 *
 *   - couldn't tell  — the tool looked and the evidence was ambiguous.
 *   - needs you      — a judgment call that never had a mechanical
 *                      answer ("surface bad news first").
 *
 * Collapsing them made the tool look like it failed on most rules. It
 * doesn't: across 40 real rules files, 52.2% of the actual rules people
 * write are judgment calls. Those aren't the tool falling short, they're
 * the half of the work that was always a human's. Naming that honestly is
 * the difference between a report that reads as broken and one that reads
 * as a division of labour.
 */
function summaryLine(results: CheckResult[]): string {
  const pass = results.filter((r) => r.status === "PASS").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  const needsHuman = results.filter((r) => r.status === "UNCLEAR" && r.needsHuman).length;
  const couldntTell = results.filter((r) => r.status === "UNCLEAR" && !r.needsHuman).length;

  const parts = [`${pass} followed`, `${fail} not followed`];
  if (couldntTell > 0) parts.push(`${couldntTell} couldn't tell`);
  if (needsHuman > 0) parts.push(`${needsHuman} need your judgment`);
  return parts.join(" · ");
}

export function generateReport(results: CheckResult[], meta: ReportMeta): string {
  const clean = results.map(sanitize);
  const lines: string[] = [];
  lines.push(`RuleReceipt · ${meta.ruleCount} rules checked`);
  lines.push("─".repeat(40));
  for (const r of clean) {
    lines.push(`${MARK[r.status]} ${r.status.padEnd(7)} ${ruleLabel(r, clean)}`);
    if (r.evidence) lines.push(`  evidence: ${r.evidence}`);
  }
  lines.push("─".repeat(40));
  lines.push(summaryLine(clean));

  const hash = computeTranscriptHash(meta.sessionFilePath);
  lines.push(hash ? `verify: sha256:${hash.slice(0, 16)}...` : "verify: no session file (demo data)");
  lines.push(`checked: ${new Date().toISOString()}`);

  return lines.join("\n");
}

/**
 * Makes a value safe to place inside a markdown table cell.
 *
 * The previous version escaped only `|`, which broke a real table three
 * separate ways (first found by CodeQL js/incomplete-sanitization, the
 * other two while fixing it):
 *
 * 1. Backslash was not escaped, so evidence containing a literal `\|`
 *    became `\\|` — rendering as a backslash followed by a live column
 *    separator, splitting the row. Backslash must be escaped FIRST, or
 *    it re-escapes the pipes added afterwards.
 * 2. The rule TITLE was not escaped at all, so any rule whose title
 *    contains a pipe broke the table. Titles come from a user's
 *    CLAUDE.md, and pipes appear naturally in shell examples.
 * 3. Newlines were not handled. stripControlChars deliberately keeps
 *    `\n` so multi-line evidence stays readable in the terminal, but a
 *    newline inside a table cell ends the row and destroys everything
 *    below it. Rendered as a literal <br> instead.
 */
function escapeMarkdownCell(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, "<br>");
}

export function generateMarkdownReport(results: CheckResult[], meta: ReportMeta): string {
  const clean = results.map(sanitize);
  const lines: string[] = [];
  lines.push(`**RuleReceipt** · ${meta.ruleCount} rules checked · ${summaryLine(clean)}`);
  lines.push("");
  lines.push("| Status | Rule | Evidence |");
  lines.push("|---|---|---|");
  for (const r of clean) {
    const evidence = escapeMarkdownCell(r.evidence || "");
    lines.push(`| ${MARK[r.status]} ${r.status} | ${escapeMarkdownCell(ruleLabel(r, clean))} | ${evidence} |`);
  }
  lines.push("");
  const hash = computeTranscriptHash(meta.sessionFilePath);
  lines.push(hash ? `\`verify: sha256:${hash.slice(0, 16)}...\` · checked ${new Date().toISOString()}` : `demo data · checked ${new Date().toISOString()}`);

  return lines.join("\n");
}
