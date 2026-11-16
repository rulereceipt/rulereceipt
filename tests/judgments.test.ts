import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CheckResult } from "../src/types.js";
import { loadJudgments, attachJudgments, toOpinion, judgedResults } from "../src/judgments.js";

function result(partial: Partial<CheckResult> & Pick<CheckResult, "ruleId" | "evidence">): CheckResult {
  return {
    ruleTitle: partial.ruleTitle ?? partial.ruleId,
    ruleSource: "project",
    status: "UNCLEAR",
    ...partial,
  } as CheckResult;
}

const needsJudgment = (id: string, evidence: string) => result({ ruleId: id, evidence, outcome: "inconclusive", needsHuman: true });
const couldntTell = (id: string, evidence: string) => result({ ruleId: id, evidence, outcome: "inconclusive", needsHuman: false });
const deterministicFail = (id: string, evidence: string) => result({ ruleId: id, evidence, status: "FAIL", outcome: "fail" });
const deterministicPass = (id: string, evidence: string) => result({ ruleId: id, evidence, status: "PASS", outcome: "pass" });

describe("judge opinions: ingest + validation", () => {
  it("loads a judgments file, tolerates a missing/garbage one", () => {
    const dir = mkdtempSync(join(tmpdir(), "rr-judge-"));
    try {
      const good = join(dir, "j.json");
      writeFileSync(good, JSON.stringify({ judgedBy: "claude", judgments: [{ ruleId: "r1", verdict: "PASS", reason: "ok", quote: "did the thing" }] }));
      const m = loadJudgments(good);
      expect(m.get("r1")?.verdict).toBe("PASS");

      expect(loadJudgments(join(dir, "nope.json")).size).toBe(0); // missing
      const bad = join(dir, "bad.json");
      writeFileSync(bad, "{ not json ");
      expect(loadJudgments(bad).size).toBe(0); // garbage, no throw
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a PASS/FAIL opinion needs a quote that verifies against the session, else it is UNCLEAR + counted", () => {
    const session = 'turn 12: ran "git push origin main"; nothing in the chat approved it';
    // quote present in the session -> kept, no failure
    expect(toOpinion({ verdict: "FAIL", reason: "pushed", quote: "git push origin main" }, session)).toEqual({
      opinion: { verdict: "FAIL", reason: "pushed", quote: "git push origin main" },
      quoteFailed: false,
    });
    // quote NOT in the session -> downgraded, quote dropped, counted as a failure
    const fab = toOpinion({ verdict: "FAIL", reason: "made it up", quote: "rm -rf /" }, session);
    expect(fab.opinion.verdict).toBe("UNCLEAR");
    expect(fab.opinion.quote).toBe("");
    expect(fab.quoteFailed).toBe(true);
    // empty quote -> UNCLEAR, counted
    expect(toOpinion({ verdict: "PASS", reason: "trust me", quote: "" }, session).opinion.verdict).toBe("UNCLEAR");
    expect(toOpinion({ verdict: "PASS", reason: "trust me", quote: "" }, session).quoteFailed).toBe(true);
    // explicit UNCLEAR stays UNCLEAR, NOT a quote failure
    expect(toOpinion({ verdict: "UNCLEAR", reason: "cannot tell", quote: "" }, session)).toEqual({
      opinion: { verdict: "UNCLEAR", reason: "cannot tell", quote: "" },
      quoteFailed: false,
    });
  });

  it("attaches only to unresolved rules; never annotates a deterministic PASS/FAIL", () => {
    const results = [
      needsJudgment("nj", "no command targeted main this session"),
      couldntTell("ct", 'a text match on "tested" alone can\'t tell'),
      deterministicFail("df", 'ran "git push origin main"'),
      deterministicPass("dp", "evidence of the thing"),
    ];
    const m = loadMap([
      { ruleId: "nj", verdict: "PASS", reason: "no violation", quote: "no command targeted main" },
      { ruleId: "ct", verdict: "PASS", reason: "inconclusive text", quote: "can't tell" },
      { ruleId: "df", verdict: "PASS", reason: "should be ignored", quote: "git push origin main" },
      { ruleId: "dp", verdict: "FAIL", reason: "should be ignored", quote: "evidence of the thing" },
    ]);
    attachJudgments(results, m);
    expect(results[0].judgment?.verdict).toBe("PASS"); // needs-judgment: annotated
    expect(results[1].judgment?.verdict).toBe("PASS"); // couldn't-tell: annotated
    expect(results[2].judgment).toBeUndefined();       // deterministic FAIL: untouched
    expect(results[3].judgment).toBeUndefined();       // deterministic PASS: untouched
    expect(judgedResults(results).map((r) => r.ruleId)).toEqual(["nj", "ct"]);
  });
});

function loadMap(items: Array<{ ruleId: string; verdict: string; reason: string; quote: string }>) {
  return new Map(items.map((i) => [i.ruleId, { verdict: i.verdict, reason: i.reason, quote: i.quote }]));
}
