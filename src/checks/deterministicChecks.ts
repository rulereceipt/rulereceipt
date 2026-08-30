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
        const haystack = eventSearchText(event);
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
          return {
            ruleId: rule.id,
            ruleTitle: rule.title,
            ruleSource: rule.source,
            status: "FAIL",
            evidence: `found banned pattern "${foundPattern}" in a ${foundEvent.kind === "tool_use" ? foundEvent.toolName + " call" : foundEvent.kind}: ${haystack.slice(0, 160)}`,
          };
        }
        return {
          ruleId: rule.id,
          ruleTitle: rule.title,
          ruleSource: rule.source,
          status: "PASS",
          evidence: `no occurrence of ${patterns.map((p) => `"${p}"`).join(" or ")} found in this session`,
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
