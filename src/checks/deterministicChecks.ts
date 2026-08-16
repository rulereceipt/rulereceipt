import type { TranscriptEvent, CheckResult } from "../types.js";
import type { DeterministicClassification } from "./classify.js";

function eventSearchText(event: TranscriptEvent): string {
  if (event.kind === "tool_use") {
    return `${event.toolName} ${JSON.stringify(event.input)}`;
  }
  if (event.kind === "text") {
    return event.text;
  }
  return event.content;
}

function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Word-boundary-aware match, not a naive substring search — otherwise a
 * pattern like "git push --force" would false-positive on the SAFER
 * "git push --force-with-lease" (caught by an actual failing test before
 * this fix, not assumed).
 */
function matchesPattern(haystack: string, pattern: string): boolean {
  const regex = new RegExp(escapeRegex(pattern) + "(?![\\w-])");
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
  return classifications.map(({ rule, patterns }) => {
    for (const event of events) {
      const haystack = eventSearchText(event);
      for (const pattern of patterns) {
        if (matchesPattern(haystack, pattern)) {
          return {
            ruleId: rule.id,
            ruleTitle: rule.title,
            status: "FAIL",
            evidence: `found banned pattern "${pattern}" in a ${event.kind === "tool_use" ? event.toolName + " call" : event.kind}: ${haystack.slice(0, 160)}`,
          };
        }
      }
    }
    return {
      ruleId: rule.id,
      ruleTitle: rule.title,
      status: "PASS",
      evidence: `no occurrence of ${patterns.map((p) => `"${p}"`).join(" or ")} found in this session`,
    };
  });
}
