import { describe, it, expect } from "vitest";
import { runRecall, TRUTHSET } from "../scripts/recall.js";

/**
 * Detection regression gate. The recall truth-set (scripts/recall.ts) is a set
 * of hand-labelled sessions run through the real engine: known violations that
 * must FAIL, compliant/near-miss sessions that must not. This asserts every one
 * still lands correctly, so a change that stops a checker CATCHING a real
 * violation (a false negative) fails the build — the counterpart to the
 * adversarial suite, which guards the false-positive direction.
 *
 * It is v1 (hand-built), so 100% here means "no regression on known cases," not
 * "catches every real-world violation." It grows as real labelled sessions are
 * added.
 */
describe("recall truth-set: every known violation is caught, every compliant case is cleared", () => {
  const r = runRecall();

  it("has a meaningful number of cases across both directions", () => {
    expect(TRUTHSET.filter((c) => c.kind === "violation").length).toBeGreaterThanOrEqual(8);
    expect(TRUTHSET.filter((c) => c.kind === "compliant").length).toBeGreaterThanOrEqual(8);
  });

  it("catches every known violation (no false negatives)", () => {
    expect(r.falseNegatives).toEqual([]);
    expect(r.caught).toBe(r.violations);
  });

  it("stays quiet on every compliant case (no false positives)", () => {
    expect(r.falsePositives).toEqual([]);
    expect(r.cleared).toBe(r.compliant);
  });
});
