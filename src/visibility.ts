import type { CheckResult } from "./types.js";
import { breakContext } from "./breakContext.js";

/**
 * "Rule not visible" (dogfood/#4). Before a Broken verdict stands, ask whether
 * the rule was even IN THE AGENT'S CONTEXT at the moment of the break. A rule
 * the agent never saw cannot have been "broken" by it — Claude Code loads
 * CLAUDE.md only when the session starts from (or a Read touches) its directory,
 * and a compaction can drop it. Counting those as Broken is a false accusation.
 *
 * So a FAIL is downgraded to `notVisible` when, read from the raw transcript:
 *   - the rules file never entered context before the break  -> "not-in-context"
 *   - it was present but not re-injected after the last compaction -> "stale-after-compaction"
 * and left as Broken when it WAS visible. When the break can't be located in the
 * transcript we do NOT guess — it stays Broken (the forbidden action is real and
 * quoted); the caller may add a "can't tell if the rule was visible" caveat.
 *
 * This runs wherever a verdict is finalized (check, history, export) so every
 * surface agrees. It changes nothing without the raw transcript text.
 */

const FIX_NOT_IN_CONTEXT =
  "The rules file was never in context here. Start the session from the project root so CLAUDE.md loads at the start, or add a SessionStart hook that injects your rules every session.";
const FIX_STALE =
  "The rules file was in context earlier but not after the last compaction. Add a post-compaction hook (SessionStart:compact) that re-injects your rules.";

/** How a would-be break relates to the rule's visibility, from the raw transcript. */
export function classifyVisibility(transcriptText: string, evidence: string):
  | { reason: "not-in-context" | "stale-after-compaction"; fix: string }
  | null {
  const ctx = breakContext(transcriptText, evidence);
  if (!ctx.located) return null; // can't find the break -> don't guess; stays Broken
  // Only downgrade when we can POSITIVELY tell the rule wasn't there: the
  // transcript shows context-injection machinery (system-reminders, attachments,
  // a compaction) yet no rules file before the break. A thin log with no such
  // machinery is can't-tell, NOT "not visible" — stays Broken.
  if (!ctx.rulesInContext) return ctx.contextObserved ? { reason: "not-in-context", fix: FIX_NOT_IN_CONTEXT } : null;
  if (ctx.rulesStaleAfterCompaction) return { reason: "stale-after-compaction", fix: FIX_STALE };
  return null; // visible before the break -> a real Broken
}

/**
 * Attach `notVisible` to any FAIL whose rule wasn't in context at the break.
 * Returns a new array (inputs untouched). A no-op without transcript text, and
 * for non-FAIL results. Called everywhere a verdict is counted so Broken means
 * the same thing in the report, the exit code, history and the team export.
 */
export function applyVisibility(results: CheckResult[], transcriptText: string | undefined): CheckResult[] {
  if (!transcriptText) return results;
  return results.map((r) => {
    if (r.status !== "FAIL" || r.notVisible || !r.evidence) return r;
    const v = classifyVisibility(transcriptText, r.evidence);
    return v ? { ...r, notVisible: v } : r;
  });
}
