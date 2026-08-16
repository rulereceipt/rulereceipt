import type { Rule, TranscriptEvent, CheckResult } from "../types.js";

/**
 * Day 3: pattern-based checks against the transcript. No API calls, no
 * data leaving the machine. Example: rule bans `git push --force` ->
 * scan tool-call events for that exact pattern.
 */
export function runDeterministicChecks(
  _rules: Rule[],
  _events: TranscriptEvent[]
): CheckResult[] {
  throw new Error("TODO: implement — start here Day 3");
}
