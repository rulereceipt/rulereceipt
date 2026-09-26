import { describe, it, expect } from "vitest";
import { classifyRule } from "../src/checks/classify.js";
import type { Rule } from "../src/types.js";

/**
 * From etoryoki on anthropics/claude-code#2544: a prohibition scoped by a
 * condition ("Never run `terraform apply` when you're on main") read as a flat
 * "never run it" flags every correct run elsewhere. A literal matcher cannot
 * see the "when/unless/if" that scopes it, so these route to judgment instead.
 */
const rule = (text: string): Rule => ({ id: "1", title: "Rule", text, source: "project" });

describe("conditional forbids route to judgment, not a literal matcher", () => {
  for (const t of [
    "Never run `terraform apply` when you are on the main branch.",
    "Do not run `npm publish` unless the version was bumped.",
    "Never run `rm -rf` except when clearing the build cache.",
    "Never merge a PR with `gh pr merge` unless CI is green.",
  ]) {
    it(`judgment: ${t.slice(0, 42)}`, () => expect(classifyRule(rule(t)).kind).toBe("judgment"));
  }
});

describe("flat prohibitions are unaffected (no regression)", () => {
  it("bare command ban stays deterministic", () => {
    expect(classifyRule(rule("Never run `git push --force`.")).kind).toBe("deterministic");
  });
  it("file ban stays fileLifecycle", () => {
    expect(classifyRule(rule("Never delete `data/ledger.db`.")).kind).toBe("fileLifecycle");
  });
  it("branch rule stays gitBranchPolicy — it evaluates its own condition", () => {
    expect(classifyRule(rule("Never commit directly to the `main` branch.")).kind).toBe("gitBranchPolicy");
  });
  it("does not sweep in a flat rule that merely contains 'if' in passing", () => {
    expect(classifyRule(rule("Never run `git push --force`, not even if asked nicely.")).kind).toBe("deterministic");
  });
});
