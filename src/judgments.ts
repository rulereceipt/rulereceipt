import { readFileSync } from "node:fs";
import type { CheckResult, JudgeOpinion } from "./types.js";
import { bucketOf } from "./report/buckets.js";

/**
 * The "judged by Claude" opinion layer.
 *
 * The deterministic checker leaves two kinds of rule unresolved: couldn't-tell
 * (a pattern matched but proves nothing on its own) and needs-judgment (a human
 * call with no command to inspect). The plugin hands each of those, one at a
 * time, to a FRESH subagent that sees ONLY the rule text and that rule's own
 * evidence — never the rest of the session — and returns an opinion. Those
 * opinions arrive here through `check --judgments <file>`.
 *
 * An opinion is never a verdict: it is displayed, clearly labelled, and never
 * counted, never changes a status/outcome, and never affects the exit code
 * (an `--llm`/opinion signal can never FAIL a build — the permanent rule). It
 * is attached ONLY to a rule the deterministic pass could not resolve; a
 * deterministic PASS or FAIL is authoritative and is never annotated.
 */

/** The on-disk shape written by the plugin (and accepted on stdin). */
interface JudgmentsFile {
  judgedBy?: string;
  judgments?: Array<{ ruleId?: unknown; verdict?: unknown; reason?: unknown; quote?: unknown }>;
}

/** Normalise for a forgiving substring check (whitespace/case-insensitive). */
function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Parse a judgments file into a map keyed by ruleId. Fails OPEN: a missing,
 * unreadable or malformed file yields an empty map and never throws — the
 * opinion layer is a convenience, and its absence must never break a check.
 */
export function loadJudgments(path: string): Map<string, { verdict: string; reason: string; quote: string }> {
  const map = new Map<string, { verdict: string; reason: string; quote: string }>();
  let raw = "";
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return map;
  }
  let parsed: JudgmentsFile;
  try {
    parsed = JSON.parse(raw) as JudgmentsFile;
  } catch {
    return map;
  }
  const list = Array.isArray(parsed?.judgments) ? parsed.judgments : [];
  for (const j of list) {
    const ruleId = typeof j?.ruleId === "string" ? j.ruleId : "";
    if (!ruleId) continue;
    const verdict = typeof j?.verdict === "string" ? j.verdict.toUpperCase() : "";
    const reason = typeof j?.reason === "string" ? j.reason : "";
    const quote = typeof j?.quote === "string" ? j.quote : "";
    // First one wins if a ruleId is repeated — deterministic and simple.
    if (!map.has(ruleId)) map.set(ruleId, { verdict, reason, quote });
  }
  return map;
}

/**
 * Validate one raw judgment into a clean opinion, verifying its quote against
 * the SESSION ITSELF.
 *
 * This is the accuracy edge: a PASS/FAIL opinion MUST carry a quote that appears
 * VERBATIM in the transcript (whitespace/case tolerant). The judge can read and
 * grep the whole session, so a claimed grade is only trustworthy if the exact
 * line it rests on is really there. A quote that does not verify is treated as a
 * fabrication: the opinion is downgraded to UNCLEAR, the quote dropped, and the
 * caller counts the miss. "No verifiable quote = UNCLEAR" — so a shown FAIL
 * opinion always points at a line a reader can find, and a model cannot assert a
 * violation it invented.
 *
 * `haystack` is the raw transcript text. When it is empty (e.g. demo data with
 * no session file), the rule's own evidence is used as the fallback haystack so
 * the mechanism still degrades honestly rather than trusting everything.
 */
export function toOpinion(
  raw: { verdict: string; reason: string; quote: string },
  haystack: string
): { opinion: JudgeOpinion; quoteFailed: boolean } {
  const reason = raw.reason.trim();
  const quote = raw.quote.trim();
  // DIDNT_APPLY is a valid opinion with no quote: the rule's trigger never
  // occurred, so there is no line to point at. It is not a quote failure.
  if (raw.verdict === "DIDNT_APPLY") {
    return { opinion: { verdict: "DIDNT_APPLY", reason, quote: "" }, quoteFailed: false };
  }
  const wantsGrade = raw.verdict === "PASS" || raw.verdict === "FAIL";
  const quoteVerified = quote.length > 0 && norm(haystack).includes(norm(quote));
  if (wantsGrade && quoteVerified) {
    return { opinion: { verdict: raw.verdict as "PASS" | "FAIL", reason, quote }, quoteFailed: false };
  }
  // A PASS/FAIL whose quote does NOT appear in the session is a verification
  // failure worth counting; an explicit UNCLEAR is not a failure, just unclear.
  const quoteFailed = wantsGrade && !quoteVerified;
  return { opinion: { verdict: "UNCLEAR", reason, quote: "" }, quoteFailed };
}

/** The outcome of attaching opinions: how many claimed grades failed quote-check. */
export interface AttachResult {
  /** PASS/FAIL opinions whose quote did not verify against the session, downgraded to UNCLEAR. */
  quoteFailures: number;
  /** How many opinions were attached in total (after validation). */
  attached: number;
}

/**
 * Attach opinions to the results they belong to, in place, verifying every
 * PASS/FAIL quote against `transcriptText` (the whole session). Only rules the
 * deterministic pass left as couldn't-tell or needs-judgment can receive one.
 * Returns how many quotes failed verification, so the caller can report it.
 */
export function attachJudgments(
  results: CheckResult[],
  judgments: Map<string, { verdict: string; reason: string; quote: string }>,
  transcriptText = ""
): AttachResult {
  let quoteFailures = 0;
  let attached = 0;
  if (judgments.size === 0) return { quoteFailures, attached };
  for (const r of results) {
    const bucket = bucketOf(r);
    if (bucket !== "UNCLEAR_JUDGMENT" && bucket !== "UNCLEAR_EVIDENCE" && bucket !== "NOT_CHECKABLE") continue;
    const raw = judgments.get(r.ruleId);
    if (!raw) continue;
    // Verify the quote against the real session; fall back to the rule's own
    // evidence only when there is no transcript to check against.
    const haystack = transcriptText.length > 0 ? transcriptText : r.evidence;
    const { opinion, quoteFailed } = toOpinion(raw, haystack);
    r.judgment = opinion;
    attached++;
    if (quoteFailed) quoteFailures++;
  }
  return { quoteFailures, attached };
}

/** The results that carry a displayed opinion, in input order. */
export function judgedResults(results: CheckResult[]): CheckResult[] {
  return results.filter((r) => r.judgment);
}

// Shared wording so every surface labels the opinion layer identically — and
// deliberately distinct from the counted words ("followed", "not followed",
// "rule not visible", "couldn't tell") so the surface-parity scraper, which
// greps those with a leading number, never mistakes a judged line for a count.
export const JUDGE_LABEL = "Judged by Claude";
export const JUDGE_NOTE = "opinion — not a verdict, never counted, never fails CI";

/** A glyph for an opinion's verdict (distinct from the verdict badges). */
export function judgeGlyph(v: JudgeOpinion["verdict"]): string {
  return v === "PASS" ? "✓" : v === "FAIL" ? "✕" : v === "DIDNT_APPLY" ? "–" : "?";
}

/** The human label for an opinion's verdict. */
export function judgeVerdictLabel(v: JudgeOpinion["verdict"]): string {
  return v === "DIDNT_APPLY" ? "DIDN'T APPLY" : v;
}

/** How many unresolved rules the judge called followed / broken / didn't-apply / still-unclear. */
export interface JudgeTally {
  followed: number;
  broken: number;
  didntApply: number;
  unclear: number;
  any: boolean;
}

export function judgeTally(results: CheckResult[]): JudgeTally {
  let followed = 0, broken = 0, didntApply = 0, unclear = 0;
  for (const r of results) {
    if (!r.judgment) continue;
    if (r.judgment.verdict === "PASS") followed++;
    else if (r.judgment.verdict === "FAIL") broken++;
    else if (r.judgment.verdict === "DIDNT_APPLY") didntApply++;
    else unclear++;
  }
  return { followed, broken, didntApply, unclear, any: followed + broken + didntApply + unclear > 0 };
}

/**
 * The labelled judged clause for a headline summary, e.g.
 *   "judged by Claude: 19 followed · 2 broken · 3 still unclear"
 * Empty string when no opinions were attached. This is an OPINION readout — the
 * deterministic counts beside it are unchanged and remain what the exit code and
 * every gate use.
 */
export function judgeSummaryClause(results: CheckResult[]): string {
  const t = judgeTally(results);
  if (!t.any) return "";
  const parts: string[] = [];
  if (t.followed) parts.push(`${t.followed} followed`);
  if (t.broken) parts.push(`${t.broken} broken`);
  if (t.didntApply) parts.push(`${t.didntApply} didn't apply`);
  if (t.unclear) parts.push(`${t.unclear} still unclear`);
  return `${JUDGE_LABEL}: ${parts.join(" · ")}`;
}
