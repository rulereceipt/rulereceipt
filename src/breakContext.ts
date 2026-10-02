/**
 * A4 — "why it broke" context for a single proven break.
 *
 * The report says WHICH rule broke and quotes the line. This adds the three
 * things a person asks next, read straight from the raw transcript (the parsed
 * event stream drops attachment/system/compaction lines, so this works on the
 * file text `check` already has):
 *
 *   1. the user's own message just before the break,
 *   2. whether the rules file (CLAUDE.md/AGENTS.md/GEMINI.md) was in context
 *      BEFORE the break at all,
 *   3. whether a compaction happened earlier in the session.
 *
 * The point of (2) is honesty, not accusation. Claude Code can load CLAUDE.md
 * only when a Read touches its directory, so a shell-heavy session may never
 * have the rule in context. When that is the case the report must say "the rules
 * file was not in context here", NOT imply the agent ignored a rule it never saw
 * — and it points at the fix (a SessionStart / post-compaction hook that injects
 * the rules). Nothing here changes a verdict; it only explains one.
 *
 * If the break line cannot be located in the transcript (evidence with no
 * quotable fragment), `located` is false and the caller shows nothing rather
 * than guessing.
 */

export interface BreakContext {
  located: boolean;
  /** The user's own typed message just before the break, clipped; undefined if none. */
  precedingUser?: string;
  /** Did a rules file appear in the transcript before the break? */
  rulesInContext: boolean;
  /** Did a compaction occur before the break? */
  compactionBefore: boolean;
  /**
   * The rules file was in context earlier, but its last appearance was BEFORE
   * the last compaction and it was not re-injected after — so the summary may
   * have dropped it. (The real session ef53e676: CLAUDE.md present before a
   * compaction, never came back.)
   */
  rulesStaleAfterCompaction: boolean;
}

// A rules file being injected into context. Covers the literal injected header
// ("Contents of .../CLAUDE.md (project instructions"), the "checked into" variant,
// and the structural claudeMd attachment (escaped or not inside a JSONL line).
const RULES_INJECTION =
  /Contents of [^\n"]*(?:CLAUDE|AGENTS|GEMINI|AGENT)[^\n"]*\.md \(project instructions|project instructions, checked into|\\?"(?:claudeMd|type\\?":\\?"claudeMd)\\?"|\\?"type\\?":\s*\\?"claudeMd/;

const COMPACTION = /"isCompactSummary"\s*:\s*true/;

/** Longest-first distinctive fragments of the evidence to find the break line by. */
function needles(evidence: string): string[] {
  const quoted = [...evidence.matchAll(/"([^"]{6,})"/g)].map((m) => m[1]);
  const after = evidence.split(/:\s/).slice(1).join(": ");
  return [...quoted, after]
    .map((s) => s.replace(/\s+/g, " ").trim().slice(0, 80))
    .filter((s) => s.length >= 6)
    .sort((a, b) => b.length - a.length);
}

/** The human's own message on a user line (string content), or null. */
function userTyped(line: string): string | null {
  try {
    const o = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } };
    if (o.type !== "user") return null;
    const c = o.message?.content;
    if (typeof c === "string" && c.trim().length > 0) return c.trim();
  } catch {
    /* partial line */
  }
  return null;
}

function clip(s: string, n = 140): string {
  const one = s.replace(/\s+/g, " ").trim();
  if (one.length <= n) return one;
  const cut = one.slice(0, n);
  const sp = cut.lastIndexOf(" ");
  return `${sp > n * 0.6 ? cut.slice(0, sp) : cut}…`;
}

/**
 * Context for the break whose evidence is `evidence`, read from the raw JSONL
 * `transcriptText`. Line-based: the break line is the LAST line carrying a
 * distinctive fragment of the evidence (so a later, unrelated mention does not
 * win), and the three facts are computed over the lines before it.
 */
export function breakContext(transcriptText: string, evidence: string): BreakContext {
  const lines = transcriptText.split(/\r?\n/);
  const ns = needles(evidence);
  let breakIdx = -1;
  if (ns.length > 0) {
    for (let i = lines.length - 1; i >= 0; i--) {
      const flat = lines[i].replace(/\s+/g, " ");
      if (ns.some((n) => flat.includes(n))) { breakIdx = i; break; }
    }
  }
  if (breakIdx === -1)
    return { located: false, rulesInContext: false, compactionBefore: false, rulesStaleAfterCompaction: false };

  let lastRulesIdx = -1;
  let lastCompactionIdx = -1;
  let precedingUser: string | undefined;
  for (let i = 0; i < breakIdx; i++) {
    const line = lines[i];
    if (RULES_INJECTION.test(line)) lastRulesIdx = i;
    if (COMPACTION.test(line)) lastCompactionIdx = i;
    const u = userTyped(line);
    if (u) precedingUser = clip(u);
  }
  const rulesInContext = lastRulesIdx !== -1;
  const compactionBefore = lastCompactionIdx !== -1;
  return {
    located: true,
    precedingUser,
    rulesInContext,
    compactionBefore,
    rulesStaleAfterCompaction: rulesInContext && compactionBefore && lastRulesIdx < lastCompactionIdx,
  };
}

/** The lines the report prints under a break, or [] when nothing is worth adding. */
export function renderBreakContext(ctx: BreakContext): string[] {
  if (!ctx.located) return [];
  const out: string[] = ["     why it broke:"];
  if (ctx.precedingUser) out.push(`       just before, you said: "${ctx.precedingUser}"`);
  if (!ctx.rulesInContext) {
    out.push("       your rules file was NOT in context at this point — not the agent ignoring a");
    out.push("       rule it never saw. Claude Code can load CLAUDE.md only when a Read touches its");
    out.push("       directory, so a shell-heavy session can miss it. Fix: a SessionStart (and");
    out.push("       post-compaction) hook that injects your rules every session.");
  } else if (ctx.rulesStaleAfterCompaction) {
    out.push("       your rules file was in context earlier but NOT after the last compaction — the");
    out.push("       summary may have dropped it. Fix: a post-compaction hook that re-injects your rules.");
  } else {
    out.push("       your rules file was in context before this.");
    if (ctx.compactionBefore)
      out.push("       (a compaction happened earlier in this session; context before it was summarised.)");
  }
  return out;
}
