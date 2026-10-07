import { homedir } from "node:os";
import { stripTerminalEscapes } from "./sanitize.js";
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
  // Private key blocks and passwords inside URLs go FIRST — before the email
  // rule, which would otherwise partially rewrite a user:pass@host authority.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "<redacted-private-key>"],
  // Scheme capped at 30 chars (every real URL scheme is short): without the cap,
  // the `*` backtracks quadratically on long NON-URL text — redact() ran ~280ms
  // on a 20k-char string and `wrong` on a large session could stall (found by a
  // suite timeout, 2026-10-05). The cap makes it linear without changing matches.
  [/([a-zA-Z][a-zA-Z0-9+.-]{0,30}:\/\/[^\s:/@]+:)[^\s:/@]+(@)/g, "$1<redacted>$2"],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "<redacted-key>"],
  [/\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{16,}/g, "<redacted-token>"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "<redacted-token>"],
  // Stripe secret/publishable/restricted/webhook keys.
  [/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, "<redacted-stripe-key>"],
  [/\bwhsec_[A-Za-z0-9]{16,}/g, "<redacted-stripe-secret>"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "<redacted-aws-key>"],
  // High-signal provider tokens with distinctive prefixes (formats are public
  // token specs, same set gitleaks/secretlint key on — knowledge, not their code).
  // Over-masking is the safe direction for a report a user may share.
  [/\bAIza[0-9A-Za-z_-]{35,}\b/g, "<redacted-google-key>"],
  [/\bya29\.[0-9A-Za-z_-]{20,}/g, "<redacted-google-oauth>"],
  [/\bglpat-[0-9A-Za-z_-]{20}\b/g, "<redacted-gitlab-token>"],
  [/\bnpm_[A-Za-z0-9]{36}\b/g, "<redacted-npm-token>"],
  [/\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g, "<redacted-sendgrid-key>"],
  [/https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9_/]+/g, "<redacted-slack-webhook>"],
  [/https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/[0-9]+\/[A-Za-z0-9_-]+/g, "<redacted-discord-webhook>"],
  // JSON Web Tokens: header.payload.signature, each base64url.
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "<redacted-jwt>"],
  // The value excludes a leading "<" so this never re-clobbers a more specific
  // placeholder an earlier rule already inserted (e.g. "token <redacted-jwt>").
  [/\b(?:Bearer|token|apikey|api_key|password|passwd|secret)(\s*[:=]\s*|\s+)["']?(?!<redacted)[^\s"']{6,}/gi, "$1<redacted>"],
  // .env-style KEY=value: an UPPERCASE_KEY assigned a non-trivial value. A short
  // value (DISABLE_LOCKS=1) is left alone so ordinary flags are not mangled.
  [/\b([A-Z][A-Z0-9_]{2,})=(["']?)[^\s"']{8,}\2/g, "$1=<redacted>"],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "<email>"],
];

/** Masks the things most likely to be private. Not a guarantee — the user is told to read it. */
export function redact(text: string, home = homedir()): string {
  // Strip terminal control sequences first: a session can embed ANSI/OSC escapes
  // that would spoof output when this redacted text is printed or shared.
  let out = stripTerminalEscapes(text);
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
    "> Masking catches common formats only. Read before sending.",
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
