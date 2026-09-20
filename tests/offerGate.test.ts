import { describe, it, expect } from "vitest";
import { gateOffer } from "../src/report/gateOffer.js";

/**
 * The offer to enforce is made where it is earned, not on arrival.
 *
 * The site describes the Stop hook to someone deciding whether to adopt the
 * tool. The report speaks to someone who has already run it and is looking
 * at rules that were broken — which is the moment the offer means something,
 * and the only moment it is not a pitch.
 *
 * Three conditions, and each one is a way of not nagging:
 *   - only when something actually failed
 *   - never when the hook is already wired up
 *   - one line, no config block; the README has the setup
 */
describe("the enforcement offer", () => {
  it("is silent when nothing failed", () => {
    expect(gateOffer({ failures: 0, hookInstalled: false })).toBeNull();
  });

  it("appears when a rule was broken", () => {
    const o = gateOffer({ failures: 2, hookInstalled: false });
    expect(o).toContain("rulereceipt hook");
  });

  it("says nothing when the hook is already installed", () => {
    expect(gateOffer({ failures: 2, hookInstalled: true })).toBeNull();
  });

  it("does not print a config block into the terminal", () => {
    const o = gateOffer({ failures: 1, hookInstalled: false }) ?? "";
    expect(o).not.toContain("{");
    expect(o.split("\n").length).toBeLessThanOrEqual(3);
  });

  it("reads as a consequence of what was just found, not as an advert", () => {
    const o = gateOffer({ failures: 1, hookInstalled: false }) ?? "";
    expect(o.toLowerCase()).not.toMatch(/\b(upgrade|pro|premium|try|free|sign up)\b/);
  });
});
