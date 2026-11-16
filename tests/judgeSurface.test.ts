import { describe, it, expect } from "vitest";
import type { CheckResult } from "../src/types.js";
import { attachJudgments } from "../src/judgments.js";
import { generateReport, generateMarkdownReport, generateJsonReport, type ReportMeta } from "../src/report/generateReport.js";
import { renderPrComment } from "../src/prComment.js";

const meta: ReportMeta = { sessionFilePath: null, ruleCount: 4 };

function baseResults(): CheckResult[] {
  return [
    { ruleId: "p", ruleTitle: "did a thing", ruleSource: "project", status: "PASS", outcome: "pass", evidence: "ran the thing" },
    { ruleId: "f", ruleTitle: "never push main", ruleSource: "project", status: "FAIL", outcome: "fail", evidence: 'ran "git push origin main"' },
    { ruleId: "nj", ruleTitle: "surface bad news first", ruleSource: "project", status: "UNCLEAR", outcome: "inconclusive", needsHuman: true, evidence: "no command targeted the branch this session" },
    { ruleId: "ct", ruleTitle: "tests before claims", ruleSource: "project", status: "UNCLEAR", outcome: "inconclusive", needsHuman: false, evidence: 'a text match on "all tests pass" can\'t tell' },
  ];
}

function withJudgments(): CheckResult[] {
  const r = baseResults();
  attachJudgments(r, new Map([
    ["nj", { verdict: "PASS", reason: "nothing contradicts it", quote: "no command targeted the branch" }],
    ["ct", { verdict: "FAIL", reason: "claimed without a run", quote: "all tests pass" }],
    ["f", { verdict: "PASS", reason: "must be ignored — deterministic FAIL", quote: "git push origin main" }],
  ]));
  return r;
}

describe("judge opinions: surfaces show them, labelled, without moving the counts", () => {
  it("deterministic JSON summary is byte-identical with and without judgments", () => {
    const without = JSON.parse(generateJsonReport(baseResults(), meta, "0.0.0")).summary;
    const withJ = JSON.parse(generateJsonReport(withJudgments(), meta, "0.0.0")).summary;
    expect(withJ).toEqual(without);
    // sanity: the deterministic verdicts are what we expect
    expect(withJ.pass).toBe(1);
    expect(withJ.fail).toBe(1);
  });

  it("JSON carries the opinion per-rule + a top-level judged block, never in summary", () => {
    const j = JSON.parse(generateJsonReport(withJudgments(), meta, "0.0.0"));
    const nj = j.results.find((r: { ruleId: string }) => r.ruleId === "nj");
    expect(nj.judgment).toEqual({ verdict: "PASS", reason: "nothing contradicts it", quote: "no command targeted the branch" });
    // deterministic FAIL never annotated
    expect(j.results.find((r: { ruleId: string }) => r.ruleId === "f").judgment).toBeUndefined();
    expect(j.judged).toMatchObject({ by: "claude", count: 2 });
    expect(j.summary.judged).toBeUndefined();
  });

  it("terminal headline carries the labelled judged clause and a judged section", () => {
    const text = generateReport(withJudgments(), meta);
    expect(text).toMatch(/Judged by Claude: 1 followed · 1 broken/);
    expect(text).toContain("PASS (judged)");
    expect(text).toContain("FAIL (judged)");
    expect(text).toContain("all tests pass"); // the quote
    // deterministic summary still present and unchanged
    expect(text).toMatch(/1 followed · 1 not followed/);
  });

  it("markdown shows a judged table", () => {
    const md = generateMarkdownReport(withJudgments(), meta);
    expect(md).toContain("Judged by Claude");
    expect(md).toMatch(/\|\s*✓ PASS \(judged\)\s*\|/);
  });

  it("PR comment headline shows the judged clause", () => {
    const receipt = JSON.parse(generateJsonReport(withJudgments(), meta, "0.0.0"));
    const pr = renderPrComment(receipt);
    expect(pr).toMatch(/Judged by Claude: 1 followed · 1 broken/);
    // deterministic headline counts unchanged
    expect(pr).toMatch(/1 broken · 1 followed/);
  });
});
