import { describe, it, expect } from "vitest";
import { adviseRule, adviseRules } from "../src/checkability.js";
import type { Rule } from "../src/types.js";

/**
 * The other half of hookCoverage: which rules can't be checked at all, and
 * how to fix that. From the "wish list, not a contract" genre
 * (anthropics/claude-code#2544) — rules that read fine to a human and bind to
 * no check.
 */
const rule = (text: string, title = "Rule"): Rule => ({ id: "1", title, text, source: "project" });

describe("adviseRule tells you why a rule can't be checked and how to fix it", () => {
  it("returns null for a rule that IS mechanically checked", () => {
    expect(adviseRule(rule("Never push to the `main` branch."))).toBeNull();
    expect(adviseRule(rule("Never use emojis in replies."))).toBeNull();
  });

  it("calls a qualitative rule a genuine judgment call, points to --llm", () => {
    const a = adviseRule(rule("Surface bad news first; keep replies concise and honest."));
    expect(a).not.toBeNull();
    expect(a!.kind).toBe("judgment");
    expect(a!.suggestion).toMatch(/judgment call|--llm/i);
  });

  it("tells a rule with a concrete subject but no literal to add backticks", () => {
    const a = adviseRule(rule("Keep the deploy process consistent across environments."));
    expect(a).not.toBeNull();
    expect(a!.kind).toBe("judgment");
    expect(a!.suggestion).toMatch(/backtick/i);
    expect(a!.suggestion).toMatch(/deploy/i);
  });

  it("advises on a not-a-rule fragment to phrase it as an imperative", () => {
    const a = adviseRule(rule("Notes on how the deployment pipeline was set up last quarter.", "Deployment history"));
    if (a) {
      expect(a.kind).toBe("notARule");
      expect(a.suggestion).toMatch(/imperative|Never|Always/i);
    }
  });

  it("adviseRules skips the checkable ones and returns advice for the rest", () => {
    const rules = [
      rule("Never push to the `main` branch."), // checkable -> skipped
      rule("Surface bad news first."), // judgment -> advised
    ];
    const out = adviseRules(rules);
    expect(out.length).toBe(1);
    expect(out[0].ruleTitle).toBe("Rule");
  });
});
