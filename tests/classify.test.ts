import { describe, it, expect } from "vitest";
import { classifyRule } from "../src/checks/classify.js";
import type { Rule } from "../src/types.js";

function makeRule(text: string, title = "Some rule"): Rule {
  return { id: "1", title, text, source: "project" };
}

describe("classifyRule", () => {
  it("classifies a rule with a backtick-quoted literal as deterministic", () => {
    const rule = makeRule("Never run `git push --force` under any circumstances.");
    const result = classifyRule(rule);
    expect(result.kind).toBe("deterministic");
  });

  it("extracts the exact literal pattern, not a paraphrase", () => {
    const rule = makeRule("Never run `git push --force`.");
    const result = classifyRule(rule);
    if (result.kind === "deterministic") {
      expect(result.patterns).toContain("git push --force");
    } else {
      throw new Error("expected deterministic classification");
    }
  });

  it("classifies a purely judgment-based rule (their real Rule 4) as judgment, not deterministic", () => {
    const rule = makeRule(
      "Lead every status report with what is broken, failing, unverified, or worse than expected.",
      "Surface bad news first"
    );
    expect(classifyRule(rule).kind).toBe("judgment");
  });

  it("defaults to judgment when text is empty (never guesses safe)", () => {
    const rule = makeRule("");
    expect(classifyRule(rule).kind).toBe("judgment");
  });

  // proves this test can fail: a rule with no backticks must NOT be
  // misclassified as deterministic
  it("FAILS the deterministic check for a rule with quotes but no backticks (sanity check)", () => {
    const rule = makeRule('Never say "done" without evidence.');
    expect(classifyRule(rule).kind).not.toBe("deterministic");
  });

  describe("polarity detection (forbid vs require)", () => {
    it("classifies a 'never' rule as forbid", () => {
      const rule = makeRule("Never run `git push --force`.");
      const result = classifyRule(rule);
      if (result.kind !== "deterministic") throw new Error("expected deterministic");
      expect(result.polarity).toBe("forbid");
    });

    it("classifies an 'always' rule as require", () => {
      const rule = makeRule("Always run `npm test` before committing.");
      const result = classifyRule(rule);
      if (result.kind !== "deterministic") throw new Error("expected deterministic");
      expect(result.polarity).toBe("require");
    });

    it("classifies a 'must' rule as require", () => {
      const rule = makeRule("You must run `npm run typecheck` before every commit.");
      const result = classifyRule(rule);
      if (result.kind !== "deterministic") throw new Error("expected deterministic");
      expect(result.polarity).toBe("require");
    });

    it("defaults to forbid when both a forbid and a require word appear (a ban stated as 'must never')", () => {
      const rule = makeRule("You must never run `rm -rf /`.");
      const result = classifyRule(rule);
      if (result.kind !== "deterministic") throw new Error("expected deterministic");
      expect(result.polarity).toBe("forbid");
    });

    it("defaults to forbid when neither signal word is present (preserves old behavior, no regression)", () => {
      const rule = makeRule("Use `npm` for this project.");
      const result = classifyRule(rule);
      if (result.kind !== "deterministic") throw new Error("expected deterministic");
      expect(result.polarity).toBe("forbid");
    });
  });

  describe("ifEditThenTest classification (new: previously fell through to judgment)", () => {
    it("classifies 'every change needs a test' as ifEditThenTest, not judgment", () => {
      const rule = makeRule("Every new function needs a corresponding test.");
      expect(classifyRule(rule).kind).toBe("ifEditThenTest");
    });

    it("classifies 'always add tests' as ifEditThenTest", () => {
      const rule = makeRule("Always add tests for every production code change.");
      expect(classifyRule(rule).kind).toBe("ifEditThenTest");
    });

    it("does NOT classify a purely descriptive test-quality rule as ifEditThenTest (needs both signals)", () => {
      const rule = makeRule("Write good, readable tests.");
      expect(classifyRule(rule).kind).not.toBe("ifEditThenTest");
    });

    it("does NOT override an existing backtick-based deterministic rule, even if it mentions tests", () => {
      const rule = makeRule("Always run `npm test` before committing.");
      expect(classifyRule(rule).kind).toBe("deterministic");
    });
  });
});
