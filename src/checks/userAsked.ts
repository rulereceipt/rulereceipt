import type { TranscriptEvent, CheckResult } from "../types.js";
import type { Classification } from "./classify.js";

/**
 * "You asked for it" — for every structured rule, not just push/commit/pr.
 *
 * If the agent did the thing a rule forbids, but the USER explicitly told it to
 * in this session, that is the user overriding their own rule, not the agent
 * breaking it. The report must not accuse the agent of it. approvalGate already
 * does this for push/commit/pr/delete; this generalises it to the other
 * structured checkers (a forbidden branch, file, or code token).
 *
 * It ONLY ever downgrades a FAIL to "can't tell" (with the user's quote) — it
 * can never create a FAIL — so, like every other moat fix, it can only remove
 * a false accusation. It is deliberately conservative to protect DETECTION: the
 * user's message must name the rule's specific subject, not be negated, and not
 * be a question about it. A vague "ship it" is not "push to `main`", so a real
 * violation there still stands.
 */

/** The forbidden thing was named, not negated ("don't edit .env" is not a yes). */
function negatedBefore(text: string, at: number): boolean {
  const before = text.slice(Math.max(0, at - 32), at);
  return /\b(?:don'?t|do\s+not|never|no|not\s+yet|without|avoid|stop|hold\s+off(?:\s+on)?|refrain\s+from)\b[\s\w'-]{0,16}$/i.test(before);
}

/** A clause that only ASKS about the subject ("should we edit .env?") is not an instruction. */
function isQuestionClause(clause: string): boolean {
  return /\?/.test(clause) || /^\s*(?:should|could|would|why|what|whether|is|are|do|does|can|shall|may)\b/i.test(clause.trim());
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A regex that matches the rule's subject as a whole token, so `.env` does not
 * match inside `.env.example` and `main` does not match inside `maintain`.
 * A trailing `(` on a code token (`console.log(`) is dropped for matching.
 */
function subjectMatcher(subject: string): RegExp {
  const bare = subject.replace(/\($/, "").trim();
  const leadBoundary = /^[\w]/.test(bare) ? "(?<![\\w-])" : "";
  const trailBoundary = /[\w]$/.test(bare) ? "(?![\\w.-])" : "(?![\\w.-])";
  return new RegExp(leadBoundary + escapeRegex(bare) + trailBoundary, "i");
}

/**
 * The user's quote if a user message in this session explicitly instructed one
 * of the rule's forbidden subjects; otherwise null. Only user text is read
 * (never the agent's own words, never tool output).
 */
export function userAskedFor(events: TranscriptEvent[], subjects: string[]): string | null {
  const usable = subjects.map((s) => s.replace(/\($/, "").trim()).filter((s) => s.length >= 2);
  if (usable.length === 0) return null;
  for (const e of events) {
    if (e.kind !== "text" || e.role !== "user") continue;
    // Look clause by clause, so a negation or question in one sentence doesn't
    // wrongly clear (or wrongly count) another.
    for (const clause of e.text.split(/(?<=[.!?\n])\s+/)) {
      if (isQuestionClause(clause)) continue;
      for (const subject of usable) {
        const m = clause.match(subjectMatcher(subject));
        if (!m || m.index === undefined) continue;
        if (negatedBefore(clause, m.index)) continue;
        return clause.replace(/\s+/g, " ").trim().slice(0, 160);
      }
    }
  }
  return null;
}

/** The forbidden subject(s) of a structured classification, or null if it has none we can name. */
function subjectsOf(c: Classification): string[] | null {
  switch (c.kind) {
    case "gitBranchPolicy":
      return [c.branchName];
    case "fileLifecycle":
      return [c.filePath];
    case "codeContent":
      return c.patterns;
    case "emojiOutput":
      return ["emoji"];
    default:
      // attribution deliberately excluded: an AI-attribution trailer is never
      // something a user meaningfully instructs the agent to author as its own,
      // and it is the project's own hard rule. approvalGate handles its own asks.
      return null;
  }
}

function ruleKey(source: string, id: string, title: string): string {
  return `${source}\u0000${id}\u0000${title}`;
}

/**
 * Downgrades a structured FAIL to "can't tell" when the user explicitly asked
 * for the rule's forbidden subject. Only ever FAIL -> UNCLEAR, never the
 * reverse — so it can only remove a false accusation. Shared by the CLI and the
 * browser evaluator so the two never disagree about it.
 */
export function downgradeUserAsked(results: CheckResult[], classifications: Classification[], events: TranscriptEvent[]): CheckResult[] {
  const subjects = new Map<string, string[]>();
  for (const c of classifications) {
    const s = subjectsOf(c);
    if (s && s.length > 0) subjects.set(ruleKey(c.rule.source, c.rule.id, c.rule.title), s);
  }
  if (subjects.size === 0) return results;
  return results.map((r) => {
    if (r.status !== "FAIL") return r;
    const s = subjects.get(ruleKey(r.ruleSource, r.ruleId, r.ruleTitle));
    if (!s) return r;
    const quote = userAskedFor(events, s);
    if (!quote) return r;
    return {
      ...r,
      status: "UNCLEAR",
      outcome: "inconclusive",
      reason: "user_asked",
      evidence: `the agent did this, but you asked for it in this session: "${quote}" — so this is you overriding your own rule, not the agent breaking it. Original finding: ${r.evidence}`,
    };
  });
}
