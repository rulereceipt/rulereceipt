import { basename } from "node:path";
import { loadRules } from "../rules.js";
import { evaluateSession } from "../evaluate.js";
import { readTranscriptFromFile, listAllSessionFiles } from "../parsers/transcriptParser.js";
import type { CheckResult, Rule } from "../types.js";

/**
 * A compliance report over MANY sessions, not one.
 *
 * The free `check` reads a single latest session — one dev, one run. The
 * enterprise question is different: "across every agent session in this org
 * this month, which policy rules were broken, and where's the evidence?"
 * This aggregates per-session results into that org-style summary. It runs on
 * whatever sessions are reachable locally today; the same aggregation feeds
 * the Compliance API (org-wide sessions) once an enterprise grants a key.
 *
 * Deterministic by default — no LLM, no network — so it can run over hundreds
 * of sessions fast. Judgment rules are surfaced as "needs review", never
 * guessed at, same honesty as everywhere else.
 */

export interface SessionAudit {
  session: string;
  when: string;
  events: number;
  violations: CheckResult[];
}

export interface ComplianceReport {
  sessionsChecked: number;
  sessionsWithViolations: number;
  totalViolations: number;
  ruleCount: number;
  byRule: { title: string; count: number }[];
  sessions: SessionAudit[];
}

function needsReview(rule: Rule): CheckResult {
  return {
    ruleId: rule.id, ruleTitle: rule.title, ruleSource: rule.source,
    status: "UNCLEAR", outcome: "not_run", method: "none", needsHuman: true,
    evidence: "judgment rule — not graded without --llm",
  };
}

export async function auditSessions(cwd: string, limit: number): Promise<ComplianceReport> {
  const rules = loadRules(cwd);
  const files = listAllSessionFiles(cwd).slice(0, Math.max(1, limit));

  const sessions: SessionAudit[] = [];
  const byRule = new Map<string, number>();
  let totalViolations = 0;

  for (const file of files) {
    const events = readTranscriptFromFile(file);
    if (events.length === 0) continue;
    const { results } = await evaluateSession(cwd, rules, events, false, needsReview);
    const violations = results.filter((r) => r.status === "FAIL");
    for (const v of violations) byRule.set(v.ruleTitle, (byRule.get(v.ruleTitle) ?? 0) + 1);
    totalViolations += violations.length;
    const first = events.find((e) => e.timestamp)?.timestamp ?? "";
    sessions.push({ session: basename(file).replace(/\.jsonl$/, ""), when: first.slice(0, 10), events: events.length, violations });
  }

  return {
    sessionsChecked: sessions.length,
    sessionsWithViolations: sessions.filter((s) => s.violations.length > 0).length,
    totalViolations,
    ruleCount: rules.length,
    byRule: [...byRule.entries()].map(([title, count]) => ({ title, count })).sort((a, b) => b.count - a.count),
    sessions,
  };
}

/** A readable / pasteable compliance report. Markdown when `md` is set. */
export function renderComplianceReport(r: ComplianceReport, md = false): string {
  const H = (s: string) => (md ? `## ${s}` : s);
  const out: string[] = [];
  out.push(md ? "# RuleReceipt — Compliance Report" : "RuleReceipt · Compliance Report");
  out.push("");
  out.push(`Checked ${r.sessionsChecked} session${r.sessionsChecked === 1 ? "" : "s"} against ${r.ruleCount} rules (project + global).`);
  out.push("");
  out.push(`${r.sessionsWithViolations} of ${r.sessionsChecked} sessions had at least one policy violation.`);
  out.push(`${r.totalViolations} total violation${r.totalViolations === 1 ? "" : "s"} across ${r.byRule.length} distinct rule${r.byRule.length === 1 ? "" : "s"}.`);
  out.push("");

  if (r.byRule.length > 0) {
    out.push(H("Most-violated rules"));
    for (const { title, count } of r.byRule.slice(0, 10)) {
      out.push(`  ${String(count).padStart(3)}×  ${title.replace(/\s+/g, " ").trim().slice(0, 70)}`);
    }
    out.push("");
  }

  const flagged = r.sessions.filter((s) => s.violations.length > 0);
  if (flagged.length > 0) {
    out.push(H("Sessions with violations"));
    for (const s of flagged) {
      out.push(`  ${s.session.slice(0, 12)}  ${s.when}  — ${s.violations.length} violation${s.violations.length === 1 ? "" : "s"}`);
      for (const v of s.violations.slice(0, 5)) {
        out.push(`    ✕ ${v.ruleTitle.replace(/\s+/g, " ").trim().slice(0, 66)}`);
        out.push(`      ${v.evidence.replace(/\s+/g, " ").trim().slice(0, 90)}`);
      }
    }
    out.push("");
  } else {
    out.push("No mechanical policy violations found in the sessions checked.");
    out.push("");
  }

  out.push("Deterministic checks only. Judgment rules are not graded here (run per-session with --llm).");
  out.push("Local sessions today; the same report runs org-wide via the Claude Compliance API for Enterprise orgs.");
  return out.join("\n");
}
