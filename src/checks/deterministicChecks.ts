import type { TranscriptEvent, CheckResult } from "../types.js";
import type { DeterministicClassification } from "./classify.js";

/**
 * Real false-positive found 2026-08-30 on an actual complex session: a
 * "no debug print() statements" rule failed because the agent ran a grep
 * for "print(" and the SEARCH RESULT (tool_result) contained the string —
 * no print statement was ever written. Same pattern hit a rule expecting
 * `Closes #N` in a PR body: it appeared in a file the agent merely read.
 * Deliberately excluding tool_result here: a deterministic check answers
 * "did the agent DO or SAY the thing," not "did anything the agent's
 * environment ever printed contain this string" — the second question
 * produces confident, wrong verdicts on content the agent never wrote.
 */
function eventSearchText(event: TranscriptEvent): string {
  if (event.kind === "tool_use") {
    return `${event.toolName} ${JSON.stringify(event.input)}`;
  }
  if (event.kind === "text") {
    return event.text;
  }
  return "";
}

/**
 * Standard short spellings of destructive flags, canonicalised before
 * matching.
 *
 * Without this, a prohibition returned PASS whenever its exact literal was
 * absent — so a rule banning `git push --force` printed "no occurrence
 * found" for a session that ran `git push -f`. Found 2026-09-08. That is
 * the inverse of the false-FAIL problem in the postmortem and the more
 * dangerous direction: a wrong FAIL sends someone to check the evidence, a
 * wrong PASS stops them looking.
 *
 * Deliberately three entries, not an open-ended table. These are stable
 * decades-old CLI conventions for the specific destructive operations rules
 * actually ban. Expansion is gated on the COMMAND CONTEXT, because a bare
 * `-f` means something different everywhere: `grep -f patterns.txt` is not
 * forcing anything, and rewriting it would invent a violation.
 *
 * `--force-with-lease` must keep passing a `--force` ban — it is the safe
 * command, and the trailing word boundary in matchesPattern already keeps
 * the two apart.
 */
const FLAG_ALIASES: Array<{ context: RegExp; short: RegExp; canonical: string }> = [
  { context: /\bgit\s+push\b/, short: /(?:^|\s)-[A-Za-z]*f/, canonical: "git push --force" },
  { context: /\bgit\s+commit\b/, short: /(?:^|\s)-[A-Za-z]*n/, canonical: "git commit --no-verify" },
  { context: /\brm\b/, short: /(?:^|\s)-(?:[A-Za-z]*r[A-Za-z]*f|[A-Za-z]*f[A-Za-z]*r)/, canonical: "rm -rf" },
];

/**
 * The text a pattern is matched against: the event's own text, plus the
 * canonical spelling of any aliased flag it used. Kept separate from the
 * text quoted back as evidence, so a report always shows what the session
 * actually ran, never a canonical form it never typed.
 */
function searchHaystack(event: TranscriptEvent): string {
  const raw = eventSearchText(event);
  if (event.kind !== "tool_use") return raw;
  const extra = FLAG_ALIASES.filter((a) => a.context.test(raw) && a.short.test(raw)).map((a) => a.canonical);
  return extra.length > 0 ? `${raw} ${extra.join(" ")}` : raw;
}

function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Word-boundary-aware match, not a naive substring search — otherwise a
 * pattern like "git push --force" would false-positive on the SAFER
 * "git push --force-with-lease" (caught by an actual failing test before
 * this fix, not assumed).
 *
 * The trailing boundary only applies when the pattern itself ends in a
 * word character — that's the only case where appending more word
 * characters could form a genuinely different, longer token (like
 * "--force" extending into "--force-with-lease"). A pattern that already
 * ends in punctuation (e.g. "http://", ".env") can't be turned into a
 * different token that way, and real occurrences of it (a real URL, a
 * real filename) always have more characters immediately after — a real
 * bug found by testing this against an actual "http://example.com"
 * string: the old unconditional boundary made "http://" unmatchable
 * against any real URL, ever.
 */
function matchesPattern(haystack: string, pattern: string): boolean {
  const lastChar = pattern[pattern.length - 1];
  const needsTrailingBoundary = /[\w-]/.test(lastChar);
  const suffix = needsTrailingBoundary ? "(?![\\w-])" : "";
  const regex = new RegExp(escapeRegex(pattern) + suffix);
  return regex.test(haystack);
}

/**
 * Checks a single deterministic rule against the transcript by scanning
 * every event for the rule's literal banned pattern(s). No API calls, no
 * data leaving the machine — pure local string matching.
 */
export function runDeterministicChecks(
  classifications: DeterministicClassification[],
  events: TranscriptEvent[]
): CheckResult[] {
  return classifications.map(({ rule, patterns, polarity }) => {
    try {
      let foundEvent: TranscriptEvent | undefined;
      let foundPattern: string | undefined;
      for (const event of events) {
        const haystack = searchHaystack(event);
        for (const pattern of patterns) {
          if (matchesPattern(haystack, pattern)) {
            foundEvent = event;
            foundPattern = pattern;
            break;
          }
        }
        if (foundEvent) break;
      }

      if (polarity === "forbid") {
        if (foundEvent && foundPattern) {
          const haystack = eventSearchText(foundEvent);
          // Deliberately UNCLEAR, never FAIL. A bare literal match proves
          // the string appeared somewhere; it cannot prove the agent DID
          // the forbidden thing. The same match is produced by grepping
          // for the pattern, quoting it in an explanation, or naming it in
          // a commit message — all compliant. Every false positive found
          // on 2026-08-30 was this exact confusion, and no amount of
          // pattern tuning fixes it, because the information needed to
          // tell action from mention is not in the string.
          //
          // Confident FAILs come only from the structured primitives
          // (gitBranchPolicy, codeContent, fileLifecycle), which read what
          // the agent actually executed or wrote. This path reports the
          // evidence and says plainly that it can't confirm a violation.
          return {
            ruleId: rule.id,
            ruleTitle: rule.title,
            ruleSource: rule.source,
            status: "UNCLEAR",
            evidence: `"${foundPattern}" appears in a ${foundEvent.kind === "tool_use" ? foundEvent.toolName + " call" : foundEvent.kind}, but a text match alone can't tell an actual violation from a mention (a search for it, a quote, an explanation) — needs a human look: ${haystack.slice(0, 160)}`,
          };
        }
        return {
          ruleId: rule.id,
          ruleTitle: rule.title,
          ruleSource: rule.source,
          status: "PASS",
          evidence: `no occurrence of ${patterns.map((p) => `"${p}"`).join(" or ")} in the commands and messages recorded this session — this is a text scan of the transcript, so it is evidence rather than proof: a spelling this checker does not know would not be caught`,
        };
      }

      // polarity === "require": absence is the failure, not presence. But
      // a session that never touched anything relevant to this rule at all
      // shouldn't be FAILed for it either — that's a false negative, and
      // per this project's own rule, a wrong FAIL is worse than an honest
      // "can't tell." With only pattern-matching (no diff/task-relevance
      // signal available at this layer), there's no reliable way to
      // distinguish "should have run this and didn't" from "this session
      // never needed to" — so a required-but-absent pattern reports
      // UNCLEAR, never a fabricated FAIL or a fabricated PASS.
      if (foundEvent && foundPattern) {
        const haystack = eventSearchText(foundEvent);
        return {
          ruleId: rule.id,
          ruleTitle: rule.title,
          ruleSource: rule.source,
          status: "PASS",
          evidence: `found required pattern "${foundPattern}" in a ${foundEvent.kind === "tool_use" ? foundEvent.toolName + " call" : foundEvent.kind}: ${haystack.slice(0, 160)}`,
        };
      }
      return {
        ruleId: rule.id,
        ruleTitle: rule.title,
        ruleSource: rule.source,
        status: "UNCLEAR",
        evidence: `required pattern ${patterns.map((p) => `"${p}"`).join(" or ")} never appeared this session — can't tell if the rule didn't apply, or applied and was skipped`,
      };
    } catch (err) {
      // A pathological pattern (e.g. extremely long) can make `new RegExp`
      // throw. One bad rule must fail closed to UNCLEAR, not crash the
      // whole report — same principle as the judgment-check error path.
      return {
        ruleId: rule.id,
        ruleTitle: rule.title,
        ruleSource: rule.source,
        status: "UNCLEAR",
        evidence: `could not check this rule's pattern: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  });
}
