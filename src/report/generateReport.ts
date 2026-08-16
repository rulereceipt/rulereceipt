import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { CheckResult } from "../types.js";

export interface ReportMeta {
  sessionFilePath: string | null;
  ruleCount: number;
}

const MARK: Record<CheckResult["status"], string> = { PASS: "✓", FAIL: "✕", UNCLEAR: "?" };

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
  const lines: string[] = [];
  lines.push(`RuleReceipt · ${meta.ruleCount} rules checked`);
  lines.push("─".repeat(40));
  for (const r of results) {
    lines.push(`${MARK[r.status]} ${r.status.padEnd(7)} ${ruleLabel(r, results)}`);
    if (r.evidence) lines.push(`  evidence: ${r.evidence}`);
  }
  lines.push("─".repeat(40));
  lines.push(summaryLine(results));

  const hash = computeTranscriptHash(meta.sessionFilePath);
  lines.push(hash ? `verify: sha256:${hash.slice(0, 16)}...` : "verify: no session file (demo data)");
  lines.push(`checked: ${new Date().toISOString()}`);

  return lines.join("\n");
}

export function generateMarkdownReport(results: CheckResult[], meta: ReportMeta): string {
  const lines: string[] = [];
  lines.push(`**RuleReceipt** · ${meta.ruleCount} rules checked · ${summaryLine(results)}`);
  lines.push("");
  lines.push("| Status | Rule | Evidence |");
  lines.push("|---|---|---|");
  for (const r of results) {
    const evidence = (r.evidence || "").replace(/\|/g, "\\|");
    lines.push(`| ${MARK[r.status]} ${r.status} | ${ruleLabel(r, results)} | ${evidence} |`);
  }
  lines.push("");
  const hash = computeTranscriptHash(meta.sessionFilePath);
  lines.push(hash ? `\`verify: sha256:${hash.slice(0, 16)}...\` · checked ${new Date().toISOString()}` : `demo data · checked ${new Date().toISOString()}`);

  return lines.join("\n");
}
