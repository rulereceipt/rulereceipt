import { describe, it, expect } from "vitest";
import { auditRules, renderAudit } from "../src/audit.js";
import type { Rule } from "../src/types.js";

/**
 * `rulereceipt audit` (2026-09-28): a rules-only health score with NO session —
 * how much of your rules file can be checked mechanically vs needs a human vs
 * is documentation. Day-one value on any rules file, no transcript required.
 */
const r = (id: string, title: string, text: string): Rule => ({ id, title, text, source: "project" });

describe("auditRules buckets rules by checkability, no session needed", () => {
  it("counts checkable, judgment, and documentation", () => {
    const rules: Rule[] = [
      r("1", "No force push", "Never run `git push --force`."), // deterministic → checkable
      r("2", "Main branch", "Never push to the `main` branch."), // gitBranchPolicy → checkable
      r("3", "Bad news", "Always surface bad news first."), // judgment
      r("S1.1", "Dir", "`src/` - the source directory"), // documentation
    ];
    const a = auditRules(rules);
    expect(a.checkable).toBeGreaterThanOrEqual(2);
    expect(a.judgment).toBeGreaterThanOrEqual(1);
    expect(a.skipped).toBeGreaterThanOrEqual(1);
    expect(a.percentCheckable).toBe(Math.round((a.checkable / (a.checkable + a.judgment)) * 100));
  });

  it("percentCheckable is 0 (never NaN) when there are no rules", () => {
    const a = auditRules([]);
    expect(a.percentCheckable).toBe(0);
    expect(a.checkable + a.judgment + a.skipped).toBe(0);
  });

  it("renders a readable summary that never claims 'compliant'", () => {
    const out = renderAudit(auditRules([r("1", "x", "Never run `git push --force`.")]));
    expect(out).toMatch(/checkable/i);
    expect(out).not.toMatch(/compliant/i);
  });

  it("tells the user when no rules were found", () => {
    expect(renderAudit(auditRules([]))).toMatch(/no rules/i);
  });
});
