import type { CheckResult } from "../types.js";

/**
 * The ONE classification every surface shares — the terminal report, the HTML
 * report, the timeline, the PR comment and the --json summary. A report that
 * disagrees with another about what a verdict is cannot be reconciled by the
 * person reading it, and an HTML report that counted a "rule not visible" FAIL
 * as "not followed" (shipped, caught 2026-10-21) is a false accusation in one
 * surface and the truth in another. So bucketing and counting live here, once.
 *
 * `notVisible` is decided FIRST: a would-be break whose rule was never in the
 * session's context is "Rule not visible", never Broken, so it can never be
 * counted as a violation anywhere.
 */
export type Bucket =
  | "FAIL"
  | "RULE_NOT_VISIBLE"
  | "UNCLEAR_EVIDENCE"
  | "NOT_RUN"
  | "PASS"
  | "NOT_APPLICABLE"
  | "UNCLEAR_JUDGMENT";

export function bucketOf(result: CheckResult): Bucket {
  if (result.notVisible) return "RULE_NOT_VISIBLE";
  switch (result.outcome) {
    case "fail":
      return "FAIL";
    case "pass":
      return "PASS";
    case "not_run":
      return "NOT_RUN";
    case "not_applicable":
      return "NOT_APPLICABLE";
    case "inconclusive":
      return result.needsHuman ? "UNCLEAR_JUDGMENT" : "UNCLEAR_EVIDENCE";
  }
  if (result.status === "FAIL") return "FAIL";
  if (result.status === "PASS") return "PASS";
  return result.needsHuman ? "UNCLEAR_JUDGMENT" : "UNCLEAR_EVIDENCE";
}

export interface Counts {
  followed: number;
  notFollowed: number;
  notVisible: number;
  couldntTell: number;
  needsJudgment: number;
  notRun: number;
  notApplicable: number;
}

/** The canonical per-bucket counts. Every surface's headline/summary derives from this. */
export function summarize(results: CheckResult[]): Counts {
  const n = (b: Bucket) => results.filter((r) => bucketOf(r) === b).length;
  return {
    followed: n("PASS"),
    notFollowed: n("FAIL"),
    notVisible: n("RULE_NOT_VISIBLE"),
    couldntTell: n("UNCLEAR_EVIDENCE"),
    needsJudgment: n("UNCLEAR_JUDGMENT"),
    notRun: n("NOT_RUN"),
    notApplicable: n("NOT_APPLICABLE"),
  };
}
