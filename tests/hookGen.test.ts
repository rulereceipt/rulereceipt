import { describe, it, expect } from "vitest";
import type { Rule } from "../src/types.js";
import {
  buildHookPlan,
  renderHookPlan,
  permissionsObject,
  hookPlanHasContent,
  type HookResultLike,
} from "../src/hookGen.js";

/**
 * `check --hooks` (hook generation). Turns the rules that FAILED or came back
 * UNCLEAR into paste-ready enforcement, built on blockHintFor so it never
 * promises a block the tool doesn't make. Guarantees under test:
 *   - only FAIL/UNCLEAR rules are considered; a PASS rule is never suggested;
 *   - a branch-policy forbid yields a native `deny` AND the guard (which scopes
 *     to the branch a permission can't);
 *   - a command-ban judged after the run is reported as after-the-run, not as a
 *     pre-flight block;
 *   - a judgment rule produces nothing mechanical;
 *   - the emitted permissions block is valid, paste-ready JSON.
 * Rule strings below are the exact ones proven to classify in classify.test.ts
 * / gitBranchPolicy.test.ts.
 */

const mk = (id: string, title: string, text: string): Rule => ({ id, title, text, source: "project" });

const BRANCH = mk("A", "No demo branch", "Never touch the `demo` branch.");       // gitBranchPolicy forbid
const FORCE  = mk("B", "No force push", "Never run `git push --force`.");         // deterministic → after-run
const JUDGE  = mk("C", "Surface bad news first", "Lead every status report with what is broken, failing, unverified, or worse than expected.");
const PRODBR = mk("D", "No prod branch", "Never touch the `prod` branch.");       // gitBranchPolicy, but PASS

const rules = [BRANCH, FORCE, JUDGE, PRODBR];
const results: HookResultLike[] = [
  { ruleId: "A", status: "FAIL", ruleTitle: "No demo branch" },
  { ruleId: "B", status: "UNCLEAR", ruleTitle: "No force push" },
  { ruleId: "C", status: "FAIL", ruleTitle: "Surface bad news first" },
  { ruleId: "D", status: "PASS", ruleTitle: "No prod branch" },
];

describe("buildHookPlan", () => {
  const plan = buildHookPlan(rules, results);

  it("considers only FAIL/UNCLEAR rules (PASS excluded)", () => {
    expect(plan.considered).toBe(3);
  });

  it("a branch-policy forbid produces a native deny entry attributed to its rule", () => {
    const deny = plan.deny.find((d) => d.entry === "Bash(git push:*)");
    expect(deny).toBeTruthy();
    expect(deny!.rules).toContain("A");
    expect(deny!.note).toMatch(/branch/i); // honest caveat: can't scope to the branch
  });

  it("the same branch rule is also covered by the guard (which can scope to the branch)", () => {
    expect(plan.guardRules.map((g) => g.id)).toContain("A");
  });

  it("a command ban judged after the run is reported as after-the-run, not a pre-flight block", () => {
    expect(plan.afterRunOnly.map((r) => r.id)).toContain("B");
    expect(plan.deny.some((d) => d.rules.includes("B"))).toBe(false);
  });

  it("a judgment rule produces nothing mechanical", () => {
    const all = [
      ...plan.deny.flatMap((d) => d.rules),
      ...plan.ask.flatMap((a) => a.rules),
      ...plan.guardRules.map((g) => g.id),
      ...plan.nativeImpossible.map((r) => r.id),
      ...plan.afterRunOnly.map((r) => r.id),
    ];
    expect(all).not.toContain("C");
  });

  it("a PASSing rule is never suggested", () => {
    const all = [
      ...plan.deny.flatMap((d) => d.rules),
      ...plan.guardRules.map((g) => g.id),
      ...plan.afterRunOnly.map((r) => r.id),
    ];
    expect(all).not.toContain("D");
  });

  it("an unknown ruleId in results is ignored, never throws", () => {
    expect(() => buildHookPlan(rules, [{ ruleId: "ZZZ", status: "FAIL" }])).not.toThrow();
  });
});

describe("renderHookPlan — paste-ready", () => {
  it("emits a valid, parseable permissions JSON block", () => {
    const plan = buildHookPlan(rules, results);
    const lines = renderHookPlan(plan);
    // Pull the JSON block: from the first "{" until braces balance (handles nesting).
    const start = lines.findIndex((l) => l.trim() === "{");
    expect(start).toBeGreaterThan(-1);
    let depth = 0, end = start;
    for (let i = start; i < lines.length; i++) {
      for (const ch of lines[i]!) { if (ch === "{") depth++; else if (ch === "}") depth--; }
      if (depth === 0) { end = i; break; }
    }
    expect(end).toBeGreaterThan(start);
    const json = lines.slice(start, end + 1).map((l) => l.trim()).join("\n");
    const parsed = JSON.parse(json);
    expect(parsed.permissions.deny).toContain("Bash(git push:*)");
  });

  it("permissionsObject matches what the block renders", () => {
    const plan = buildHookPlan(rules, results);
    const obj = permissionsObject(plan);
    expect(obj!.permissions.deny).toContain("Bash(git push:*)");
  });

  it("says so honestly when nothing broke", () => {
    const plan = buildHookPlan(rules, [{ ruleId: "A", status: "PASS" }]);
    expect(hookPlanHasContent(plan)).toBe(false);
    expect(renderHookPlan(plan).join("\n")).toMatch(/nothing (broke|to harden)/i);
  });

  it("says so honestly when only judgment rules are in question", () => {
    const plan = buildHookPlan(rules, [{ ruleId: "C", status: "FAIL" }]);
    expect(plan.considered).toBe(1);
    expect(hookPlanHasContent(plan)).toBe(false);
    expect(renderHookPlan(plan).join("\n")).toMatch(/judgment/i);
  });
});
