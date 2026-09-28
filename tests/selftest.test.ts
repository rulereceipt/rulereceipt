import { describe, it, expect } from "vitest";
import { runSelfTestChecks, renderSelfTest } from "../src/selftest.js";

/**
 * The golden fixtures behind `rulereceipt selftest` are ALSO the regression
 * suite: if any of these hand-checked verdicts ever changes, this fails the
 * build. That is the point — the command can only honestly say "all correct"
 * if this test guarantees it.
 */
describe("selftest golden fixtures", () => {
  it("every bundled fixture gets its expected verdict", () => {
    const r = runSelfTestChecks();
    expect(r.failures).toEqual([]);
    expect(r.total).toBeGreaterThanOrEqual(8);
    expect(r.passed).toBe(r.total);
  });

  it("renders 'all correct' with the zero-network claim", () => {
    const out = renderSelfTest(runSelfTestChecks());
    expect(out).toContain("all correct");
    expect(out).toContain("0 network calls");
  });
});
