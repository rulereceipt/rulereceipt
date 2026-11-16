import { describe, it, expect } from "vitest";
import { isNotCheckableFromSession } from "../src/notCheckable.js";
import type { CheckResult } from "../src/types.js";
import { bucketOf, summarize } from "../src/report/buckets.js";
import { generateReport, generateJsonReport, type ReportMeta } from "../src/report/generateReport.js";

describe("classifier: not checkable from a session", () => {
  it("fires on rules about intent / mindset / care", () => {
    for (const title of [
      "Think carefully before you push",
      "Use good judgment when deciding scope",
      "Be thorough and deliberate in review",
      "Keep accessibility in mind",
      "Pay attention to detail",
      "Approach the problem thoughtfully",
      "Don't overthink the abstraction",
    ]) {
      expect(isNotCheckableFromSession(title), title).toBe(true);
    }
  });

  it("does NOT fire on rules with an observable action", () => {
    for (const title of [
      "Never push to main",
      "Never commit the .env file",
      "Run the tests before claiming done",
      "Surface bad news first in the status report",
      "Delete the temp directory after use",
      "Always open a PR for changes",
    ]) {
      expect(isNotCheckableFromSession(title), title).toBe(false);
    }
  });

  it("does NOT fire on behavioural/meta rules a transcript CAN inform", () => {
    // These describe observable behaviour over the session (did the report lead
    // with bad news? did claims carry evidence?), so the judge should get them —
    // they must stay judgeable, not be written off as uncheckable.
    for (const title of [
      "Surface bad news first",
      "Evidence or it didn't happen",
      "No silent scope changes",
      "Distinguish the three states honestly",
      "Execution mode, not validation mode",
      "In-sample results are not results",
    ]) {
      expect(isNotCheckableFromSession(title), title).toBe(false);
    }
  });
});

describe("not-checkable is its own bucket, status unchanged", () => {
  const r = (ruleId: string, ruleTitle: string, needsHuman: boolean): CheckResult => ({
    ruleId, ruleTitle, ruleSource: "project", status: "UNCLEAR", outcome: "inconclusive", needsHuman, evidence: "NEEDS HUMAN REVIEW",
  });

  it("splits a mindset judgment rule out of needs-judgment without changing its UNCLEAR status", () => {
    const mindset = r("a", "Think carefully about edge cases", true);
    const judgment = r("b", "Surface bad news first", true);
    expect(bucketOf(mindset)).toBe("NOT_CHECKABLE");
    expect(bucketOf(judgment)).toBe("UNCLEAR_JUDGMENT");
    // status is untouched — the verdict is identical, only the bucket refines
    expect(mindset.status).toBe("UNCLEAR");
    const c = summarize([mindset, judgment]);
    expect(c.notCheckable).toBe(1);
    expect(c.needsJudgment).toBe(1);
  });

  it("shows in the terminal and --json as its own, non-counted group", () => {
    const meta: ReportMeta = { sessionFilePath: null, ruleCount: 1 };
    const results = [r("a", "Think carefully about edge cases", true)];
    const text = generateReport(results, meta);
    expect(text).toContain("Not checkable from a session");
    const j = JSON.parse(generateJsonReport(results, meta, "0.0.0"));
    expect(j.summary.notCheckable).toBe(1);
    expect(j.summary.needsJudgment).toBe(0);
  });
});
