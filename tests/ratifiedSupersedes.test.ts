import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveOverride, ruleFingerprint, loadOverrides, ratifiedForbids } from "../src/overrides.js";
import { classifyRule } from "../src/checks/classify.js";
import type { Rule } from "../src/types.js";

/**
 * A human mark supersedes the classifier, including its refusal to classify.
 *
 * Shipped broken in 0.1.39 and caught by running the published package: the
 * mark saved correctly, the literal matched, and the guard allowed the
 * command anyway. The guard only consulted rules the classifier had called
 * `deterministic`, and the rule in the test was not one.
 *
 * The rule was "Never use `git push --force`; prefer `git push
 * --force-with-lease`." — which hasMixedPolarity sends to judgment, with the
 * reason written in place: "a rule that both forbids and prescribes can't be
 * checked by literal matching without misattributing one half's tokens to
 * the other."
 *
 * That reasoning is right, and it describes precisely the situation clause
 * marking exists to end. A rule naming both the ban and the alternative is
 * the canonical case for someone saying which is which. Gating the mark
 * behind the classifier meant the feature was unavailable in the only case
 * that motivated it.
 *
 * So the mark is read from the rule, not from the classification. Ratify-once
 * means the person's statement replaces the inference — including the
 * inference "I cannot tell, so this is a judgment call."
 */
let dir: string;
const MIXED = "Never use `git push --force`; prefer `git push --force-with-lease`.";
const rule: Rule = { id: "1", title: "Force push", text: MIXED, source: "project" };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rr-sup-"));
  mkdirSync(join(dir, "sub"), { recursive: true });
  writeFileSync(join(dir, "CLAUDE.md"), `## 1. Force push\n${MIXED}\n`);
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("a ratified clause outranks the classifier", () => {
  it("the rule really is routed to judgment, which is why this matters", () => {
    expect(classifyRule(rule).kind).toBe("judgment");
  });

  it("the mark is still readable on a rule the classifier declined", () => {
    saveOverride(dir, { hash: ruleFingerprint(rule), decision: "rule", title: rule.title, forbids: ["git push --force"] });
    expect(ratifiedForbids(loadOverrides(dir), rule)).toEqual(["git push --force"]);
  });

  it("marks only the ban, never the alternative the rule recommends", () => {
    saveOverride(dir, { hash: ruleFingerprint(rule), decision: "rule", title: rule.title, forbids: ["git push --force"] });
    const marked = ratifiedForbids(loadOverrides(dir), rule);
    expect(marked).toContain("git push --force");
    expect(marked).not.toContain("git push --force-with-lease");
  });

  it("an explicit not-a-rule decision still wins over a stale mark", () => {
    saveOverride(dir, { hash: ruleFingerprint(rule), decision: "notARule", title: rule.title, forbids: ["git push --force"] });
    const entry = loadOverrides(dir).get(ruleFingerprint(rule));
    expect(entry?.decision).toBe("notARule");
  });
});
