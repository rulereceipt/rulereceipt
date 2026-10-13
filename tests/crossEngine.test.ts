import { describe, it, expect } from "vitest";
import { hookDecisionFor } from "../src/hook.js";
import { applyVisibility } from "../src/visibility.js";
import { generateJsonReport, type ReportMeta } from "../src/report/generateReport.js";
import type { CheckResult } from "../src/types.js";

/**
 * Cross-engine invariant: the SAME verdicts must mean the same thing in `check`
 * (report) and in the Stop `hook`. Both consume evaluateSession output; the report
 * renders it and the hook decides block/allow from it. They may disagree in exactly
 * ONE documented place — an `unverifiedClaim` (report: UNCLEAR, hook: block).
 *
 * This locks the fix for a real inconsistency found 2026-10-13: `applyVisibility`
 * (a broken-but-not-visible rule is "Rule not visible", NOT Broken) ran in the
 * check/report/export path but NOT in the hook, so the hook would block the agent
 * on a rule the report said was not broken. visibility.ts even claimed it "runs
 * wherever a verdict is finalized … so every surface agrees" — the hook was the gap.
 */

const META: ReportMeta = { sessionFilePath: "/dev/null" } as ReportMeta;
const reportBrokenCount = (results: CheckResult[]): number =>
  JSON.parse(generateJsonReport(results, META, "0.0.0")).summary.fail;

// A not-visible transcript: context machinery present (a system-reminder) but no
// rules file before the break — classifyVisibility → not-in-context.
const push = JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "git push origin main" } }] } });
const otherReminder = JSON.stringify({ type: "user", message: { role: "user", content: "<system-reminder>a background note, not a rules file</system-reminder>" } });
const injectRules = JSON.stringify({ type: "user", message: { role: "user", content: "<system-reminder>\nContents of /p/CLAUDE.md (project instructions, checked into the codebase):\nNever push to main.\n</system-reminder>" } });
const transcript = (...lines: string[]) => lines.join("\n") + "\n";

const EV = 'the session ran "git push origin main"';
const brokenBranch = (): CheckResult => ({ ruleId: "1", ruleTitle: "Never push to main", ruleSource: "project", status: "FAIL", outcome: "fail", evidence: EV });

describe("cross-engine: hook block-set agrees with the report's broken count", () => {
  it("a broken-but-NOT-visible rule: report = not broken AND hook does NOT block (the fix)", () => {
    const raw = [brokenBranch()];
    const text = transcript(otherReminder, push);
    // check/report path applies visibility:
    const checkResults = applyVisibility(raw, text);
    expect(reportBrokenCount(checkResults)).toBe(0); // "Rule not visible", not broken
    // hook path (shared decision, same transcript):
    expect(hookDecisionFor(raw, text).block).toBe(false); // must agree — no accusation
  });

  it("REGRESSION GUARD: the OLD hook filter (no visibility) WOULD have blocked it", () => {
    // Documents the bug this fixed: the pre-2026-10-13 filter had no visibility step.
    const raw = [brokenBranch()];
    const oldFilterWouldBlock = raw.filter((r) => r.status === "FAIL" && r.outcome !== "not_run").length > 0;
    expect(oldFilterWouldBlock).toBe(true); // the inconsistency that existed
    // ...and the fixed decision no longer does, for the not-visible transcript:
    expect(hookDecisionFor(raw, transcript(otherReminder, push)).block).toBe(false);
  });

  it("a broken-AND-visible rule: report = 1 broken AND hook blocks (both agree it is real)", () => {
    const raw = [brokenBranch()];
    const text = transcript(injectRules, push);
    expect(reportBrokenCount(applyVisibility(raw, text))).toBe(1);
    expect(hookDecisionFor(raw, text).block).toBe(true);
  });

  it("the ONE sanctioned disagreement: an unverifiedClaim is UNCLEAR in the report but blocks the hook", () => {
    const unverified: CheckResult = { ruleId: "3", ruleTitle: "Evidence", ruleSource: "global", status: "UNCLEAR", needsHuman: true, unverifiedClaim: true, evidence: "claimed passing, nothing ran here" };
    expect(reportBrokenCount([unverified])).toBe(0); // report: not broken
    expect(hookDecisionFor([unverified], undefined).block).toBe(true); // hook: block (by design)
  });

  it("a clean PASS session: report 0 broken, hook allows", () => {
    const pass: CheckResult = { ruleId: "4", ruleTitle: "ok", ruleSource: "project", status: "PASS", evidence: "" };
    expect(reportBrokenCount([pass])).toBe(0);
    expect(hookDecisionFor([pass], undefined).block).toBe(false);
  });
});
