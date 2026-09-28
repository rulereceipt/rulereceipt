import { homedir } from "node:os";
import type { CheckResult, Rule, TranscriptEvent } from "./types.js";
import { ruleFingerprint } from "./overrides.js";

/**
 * `rulereceipt wrong <rule>` — turn "this verdict is wrong" into a report
 * someone can actually file, without sending anything anywhere.
 *
 * Added 2026-09-28. The "A result looks wrong" issue template already asked the
 * right questions, but nothing in the tool pointed to it, and filling it meant
 * copying the rule, the verdict and the evidence by hand. A user who sees a
 * wrong verdict and has to do that mostly uninstalls instead, and the project
 * loses the one kind of report every accuracy fix has come from.
 *
 * Privacy: nothing is sent. The report is written to a local file and shown
 * first; the issue link is printed for the user to open themselves. Obvious
 * secrets, the home directory and email addresses are masked before either is
 * produced, and the user is told to read it before sharing.
 */

export const ISSUE_BASE = "https://github.com/rulereceipt/rulereceipt/issues/new";

/** The dropdown options of .github/ISSUE_TEMPLATE/wrong-result.yml, verbatim. */
export function reportedLabel(r: CheckResult): string {
  if (r.status === "FAIL") return "Not followed";
  if (r.status === "PASS") return "Followed";
  if (r.needsHuman || r.outcome === "not_run") return "Needs your judgment";
  return "Couldn't tell";
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "<redacted-key>"],
  [/\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{16,}/g, "<redacted-token>"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "<redacted-token>"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "<redacted-aws-key>"],
  [/\b(?:Bearer|token|apikey|api_key|password|passwd|secret)(\s*[:=]\s*|\s+)["']?[^\s"']{6,}/gi, "$1<redacted>"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "<redacted-private-key>"],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "<email>"],
];

/** Masks the things most likely to be private. Not a guarantee — the user is told to read it. */
export function redact(text: string, home = homedir()): string {
  let out = text;
  if (home && home.length > 1) out = out.split(home).join("~");
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  return out;
}

function eventLine(e: TranscriptEvent): string {
  if (e.kind === "text") return `${e.role}: ${e.text}`;
  if (e.kind === "tool_use") {
    const input = e.input as Record<string, unknown> | null;
    const main = input?.command ?? input?.file_path ?? input?.notebook_path ?? JSON.stringify(input ?? {});
    return `assistant ran ${e.toolName}: ${String(main)}`;
  }
  return `tool result${e.isError ? " (error)" : ""}: ${e.content}`;
}

/**
 * A few events around the one the evidence quotes, so the reader can see what
 * happened just before and after. Found by the longest quoted fragment of the
 * evidence; if nothing matches, no excerpt (never a guessed one).
 */
export function excerptAround(events: TranscriptEvent[], evidence: string, radius = 2): string[] {
  const quoted = [...evidence.matchAll(/"([^"]{6,})"/g)].map((m) => m[1]);
  const after = evidence.split(/:\s/).slice(1).join(": ");
  const needles = [...quoted, after].map((s) => s.trim().slice(0, 60)).filter((s) => s.length >= 6).sort((a, b) => b.length - a.length);
  if (needles.length === 0) return [];
  // Evidence strings collapse whitespace; the session keeps newlines. Compare both the same way.
  const flat = (t: string) => t.replace(/\s+/g, " ");
  const idx = events.findIndex((e) => needles.some((n) => flat(eventLine(e)).includes(flat(n))));
  if (idx === -1) return [];
  return events.slice(Math.max(0, idx - radius), idx + radius + 1).map((e) => eventLine(e).replace(/\s+/g, " ").slice(0, 240));
}

export interface WrongReportInput {
  version: string;
  rule: Rule;
  result: CheckResult;
  events: TranscriptEvent[];
  withContext?: boolean;
  home?: string;
}

export interface WrongReport {
  handle: string;
  markdown: string;
  issueUrl: string;
}

const MAX_URL = 7500;

export function buildWrongReport(input: WrongReportInput): WrongReport {
  const { version, rule, result, events } = input;
  const r = (s: string) => redact(s, input.home);
  const handle = ruleFingerprint(rule);
  const ruleText = r(rule.text && rule.text !== rule.title ? `${rule.title}\n${rule.text}` : rule.title);
  const reported = reportedLabel(result);
  const excerpt = input.withContext === false ? [] : excerptAround(events, result.evidence).map(r);

  const how = [
    result.method ? `method: ${result.method}` : "",
    result.outcome ? `outcome: ${result.outcome}` : "",
    result.reason ? `reason: ${result.reason}` : "",
    result.ceiling ? `limits: ${r(result.ceiling)}` : "",
  ].filter(Boolean);

  const markdown = [
    `# Wrong verdict report (rulereceipt ${version})`,
    "",
    "> Read this before sharing. Obvious secrets, your home path and email addresses were masked,",
    "> but rule text and session lines are quoted as they are. Edit anything private.",
    "",
    `**Rule handle:** \`${handle}\`  (id ${result.ruleId}, ${result.ruleSource})`,
    "",
    "## The rule",
    "```",
    ruleText,
    "```",
    "",
    `## What RuleReceipt reported: ${reported}`,
    "",
    "```",
    r(result.evidence),
    "```",
    ...(how.length ? ["", ...how.map((h) => `- ${h}`)] : []),
    ...(excerpt.length ? ["", "## Session lines around it", "```", ...excerpt, "```"] : []),
    "",
    "## What you expected instead",
    "",
    "_(write it here)_",
    "",
  ].join("\n");

  const params = new URLSearchParams({
    template: "wrong-result.yml",
    title: `Wrong verdict: ${reported} on "${r(rule.title).slice(0, 60)}"`,
    rule: ruleText,
    reported,
    evidence: r(result.evidence),
    version,
  });
  let issueUrl = `${ISSUE_BASE}?${params.toString()}`;
  if (issueUrl.length > MAX_URL) {
    params.set("rule", ruleText.slice(0, 1500));
    params.set("evidence", r(result.evidence).slice(0, 1500));
    issueUrl = `${ISSUE_BASE}?${params.toString()}`;
  }
  return { handle, markdown, issueUrl };
}

/**
 * The link for a shared report (HTML). No rule text and no evidence in it: that
 * report is often sent to someone else, and a link should not leak what the
 * page deliberately shows only to its reader.
 */
export function minimalIssueUrl(result: CheckResult, version: string): string {
  const params = new URLSearchParams({ template: "wrong-result.yml", reported: reportedLabel(result), version });
  return `${ISSUE_BASE}?${params.toString()}`;
}

/** Finds the result a user means: by 12-char handle, or by id when that id is unique. */
export function findTarget(
  query: string,
  rules: Rule[],
  results: CheckResult[]
): { rule: Rule; result: CheckResult } | { ambiguous: Array<{ handle: string; title: string }> } | null {
  const pairs = results
    .map((result) => ({ result, rule: rules.find((ru) => ru.source === result.ruleSource && ru.id === result.ruleId && ru.title === result.ruleTitle) }))
    .filter((p): p is { result: CheckResult; rule: Rule } => Boolean(p.rule));
  const q = query.trim();
  const byHandle = pairs.filter((p) => ruleFingerprint(p.rule) === q || (q.length >= 6 && ruleFingerprint(p.rule).startsWith(q)));
  if (byHandle.length === 1) return byHandle[0];
  const byId = pairs.filter((p) => p.result.ruleId === q);
  if (byId.length === 1) return byId[0];
  const many = byHandle.length > 1 ? byHandle : byId;
  if (many.length > 1) return { ambiguous: many.map((p) => ({ handle: ruleFingerprint(p.rule), title: p.rule.title })) };
  return null;
}
