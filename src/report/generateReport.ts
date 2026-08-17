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

function summaryLine(results: CheckResult[]): string {
  const pass = results.filter((r) => r.status === "PASS").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  const unclear = results.filter((r) => r.status === "UNCLEAR").length;
  return `${pass} pass · ${fail} fail · ${unclear} unclear`;
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

export function generateMarkdownReport(results: CheckResult[], meta: ReportMeta): string {
  const clean = results.map(sanitize);
  const lines: string[] = [];
  lines.push(`**RuleReceipt** · ${meta.ruleCount} rules checked · ${summaryLine(clean)}`);
  lines.push("");
  lines.push("| Status | Rule | Evidence |");
  lines.push("|---|---|---|");
  for (const r of clean) {
    const evidence = (r.evidence || "").replace(/\|/g, "\\|");
    lines.push(`| ${MARK[r.status]} ${r.status} | ${ruleLabel(r, clean)} | ${evidence} |`);
  }
  lines.push("");
  const hash = computeTranscriptHash(meta.sessionFilePath);
  lines.push(hash ? `\`verify: sha256:${hash.slice(0, 16)}...\` · checked ${new Date().toISOString()}` : `demo data · checked ${new Date().toISOString()}`);

  return lines.join("\n");
}
