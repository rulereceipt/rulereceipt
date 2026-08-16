import type { Rule, TranscriptEvent, CheckResult } from "../types.js";

/**
 * Day 4: one structured-output API call, using the user's OWN Anthropic
 * API key (read from their existing env/config — never hardcoded, never
 * logged). Ask for PASS/FAIL/UNCLEAR + a one-line evidence quote per rule.
 * On API error, rate limit, or malformed response: fail closed — report
 * UNCLEAR, never silently mark a rule as PASS.
 */
export async function runJudgmentChecks(
  _rules: Rule[],
  _events: TranscriptEvent[]
): Promise<CheckResult[]> {
  throw new Error("TODO: implement — start here Day 4");
}
