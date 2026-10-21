import { describe, it, expect } from "vitest";
import type { CheckResult } from "../src/types.js";
import { summarize } from "../src/report/buckets.js";
import { generateReport, generateJsonReport, type ReportMeta } from "../src/report/generateReport.js";
import { generateHtmlReport, type HtmlReportMeta } from "../src/report/generateHtmlReport.js";
import { buildTimeline } from "../src/timeline.js";
import { renderPrComment } from "../src/prComment.js";

/**
 * CROSS-SURFACE COUNT PARITY (permanent gate, added 2026-10-21 after the HTML
 * report counted a "rule not visible" FAIL as "not followed" while the terminal
 * did not). Every surface — terminal, --json, --html, --timeline, PR comment —
 * must report the SAME four counts for a session: followed / not followed / not
 * visible / couldn't tell. A mismatch is a false accusation in one surface and
 * the truth in another, and blocks release.
 */

const R = (over: Partial<CheckResult> & { ruleId: string }): CheckResult => ({
  ruleTitle: "rule " + over.ruleId,
  ruleSource: "project",
  status: "UNCLEAR",
  evidence: "evidence for " + over.ruleId,
  ...over,
}) as CheckResult;

// One of every bucket. The notVisible one is pre-marked so it stays not-visible;
// the plain FAIL stays broken because an empty transcript leaves visibility
// undetermined (a would-be break stays broken).
const results: CheckResult[] = [
  R({ ruleId: "pass", status: "PASS", outcome: "pass", evidence: "did it" }),
  R({ ruleId: "broken", status: "FAIL", outcome: "fail", evidence: "git push origin main" }),
  R({ ruleId: "notvis", status: "FAIL", outcome: "fail", evidence: "edited .env",
     notVisible: { reason: "not-in-context", fix: "re-inject the rule" } as CheckResult["notVisible"] }),
  R({ ruleId: "cant", status: "UNCLEAR", outcome: "inconclusive", needsHuman: false, evidence: "ambiguous mention" }),
  R({ ruleId: "judge", status: "UNCLEAR", outcome: "inconclusive", needsHuman: true, evidence: "" }),
  R({ ruleId: "napply", status: "UNCLEAR", outcome: "not_applicable", needsHuman: false, evidence: "never came up" }),
];

const C = summarize(results);
const meta: ReportMeta = { sessionFilePath: null, ruleCount: results.length };
const htmlMeta: HtmlReportMeta = { ...meta, projectPath: "/x/web-api", generatedAt: new Date("2026-10-21T00:00:00Z"), toolVersion: "0.1.118" };

function nums(re: RegExp, s: string): Record<string, number> {
  const m = re.exec(s);
  if (!m?.groups) throw new Error("no match for " + re + "\n--\n" + s.slice(0, 600));
  return Object.fromEntries(Object.entries(m.groups).map(([k, v]) => [k, Number(v)]));
}

describe("cross-surface count parity — followed / not followed / not visible / couldn't tell", () => {
  it("the canonical summary is the expected one-of-each", () => {
    expect(C).toMatchObject({ followed: 1, notFollowed: 1, notVisible: 1, couldntTell: 1, needsJudgment: 1, notApplicable: 1 });
  });

  it("terminal report matches the canonical counts", () => {
    const out = generateReport(results, meta, "");
    const n = nums(/(?<followed>\d+) followed · (?<notFollowed>\d+) not followed · (?<notVisible>\d+) rule not visible · (?<couldntTell>\d+) couldn't tell/, out);
    expect(n).toMatchObject({ followed: C.followed, notFollowed: C.notFollowed, notVisible: C.notVisible, couldntTell: C.couldntTell });
  });

  it("--html report matches the canonical counts", () => {
    const out = generateHtmlReport(results, htmlMeta);
    const n = nums(/(?<followed>\d+) followed · (?<notFollowed>\d+) not followed · (?<notVisible>\d+) rule not visible · (?<couldntTell>\d+) couldn&#39;t tell/, out);
    expect(n).toMatchObject({ followed: C.followed, notFollowed: C.notFollowed, notVisible: C.notVisible, couldntTell: C.couldntTell });
  });

  it("--json summary matches the canonical counts", () => {
    const j = JSON.parse(generateJsonReport(results, meta, "0.1.118"));
    expect({ followed: j.summary.pass, notFollowed: j.summary.fail, notVisible: j.summary.ruleNotVisible, couldntTell: j.summary.couldntTell })
      .toMatchObject({ followed: C.followed, notFollowed: C.notFollowed, notVisible: C.notVisible, couldntTell: C.couldntTell });
  });

  it("--timeline counts match the canonical counts", () => {
    const t = buildTimeline(results, "");
    expect({ followed: t.counts.followed, notFollowed: t.counts.broken, notVisible: t.counts.notVisible, couldntTell: t.counts.cantTell })
      .toMatchObject({ followed: C.followed, notFollowed: C.notFollowed, notVisible: C.notVisible, couldntTell: C.couldntTell });
  });

  it("HTML: a lone not-visible FAIL is 0 not followed, shown under 'Rule not visible'", () => {
    const only = [results[2]]; // the notVisible FAIL
    const out = generateHtmlReport(only, htmlMeta);
    expect(out).toContain("Rule not visible (not a violation)");
    expect(out).toContain("0 followed · 0 not followed · 1 rule not visible");
    expect(out).toContain("No rule violations found"); // headline, NOT "1 rule not followed"
    expect(out).not.toMatch(/\b1 rule not followed\b/);
  });

  it("PR comment counts match the canonical counts", () => {
    const receipt = JSON.parse(generateJsonReport(results, meta, "0.1.118"));
    const md = renderPrComment(receipt);
    const n = nums(/(?<notFollowed>\d+) broken · (?<followed>\d+) followed · (?<couldntTell>\d+) can't tell/, md);
    expect(n).toMatchObject({ followed: C.followed, notFollowed: C.notFollowed, couldntTell: C.couldntTell });
  });
});
