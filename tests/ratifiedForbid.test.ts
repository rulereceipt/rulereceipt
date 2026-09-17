import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOverrides, saveOverride, ruleFingerprint, ratifiedForbids } from "../src/overrides.js";
import type { Rule } from "../src/types.js";

/**
 * Which backtick is the prohibition, said by a person rather than guessed.
 *
 * This is the last gap the PreToolUse guard could not close by measurement.
 * Blocking on a rule's command literals refused 62.8% of 16,336 real tool
 * calls; two narrowings reached 2.49%, and the residue had no matcher fix. A
 * rule titled "Feature Validation" refused `npm run build` 112 times because
 * it forbids running Playwright unprompted and RECOMMENDS `npm run build`,
 * which is its only command-shaped literal. Another refused plain
 * `git status`, because its backticks hold both the thing it bans and the
 * thing it suggests instead.
 *
 * Nothing in a rules file marks which clause is the obligation. So a person
 * marks it, once, against the rule's content hash — the same shape as the
 * is-it-a-rule correction that already exists, applied one field down.
 *
 * Named by stonianua on anthropics/claude-code#90542, 2026-09-16: "Command
 * bans stay reports, not blocks, until a human marks the forbid clause. That
 * is ratify-once applied to clause selection, not just polarity."
 *
 * The property under test is the safety one, and it is the reason this can
 * exist at all: an UNRATIFIED rule yields nothing. Not a guess, not a
 * fallback to "probably the first literal". Nothing.
 */
let dir: string;
const rule: Rule = { id: "1", title: "Force push", text: "Never use `git push --force`; prefer `git push --force-with-lease`.", source: "project" };

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rr-ratify-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("ratified forbid clauses", () => {
  it("yields nothing for a rule nobody has marked", () => {
    expect(ratifiedForbids(loadOverrides(dir), rule)).toEqual([]);
  });

  it("yields exactly what the person marked", () => {
    saveOverride(dir, { hash: ruleFingerprint(rule), decision: "rule", title: rule.title, forbids: ["git push --force"] });
    expect(ratifiedForbids(loadOverrides(dir), rule)).toEqual(["git push --force"]);
  });

  it("never yields the literal that was not marked", () => {
    saveOverride(dir, { hash: ruleFingerprint(rule), decision: "rule", title: rule.title, forbids: ["git push --force"] });
    expect(ratifiedForbids(loadOverrides(dir), rule)).not.toContain("git push --force-with-lease");
  });

  it("survives a reload from disk", () => {
    saveOverride(dir, { hash: ruleFingerprint(rule), decision: "rule", title: rule.title, forbids: ["git push --force"] });
    const reloaded = loadOverrides(dir).get(ruleFingerprint(rule));
    expect(reloaded?.forbids).toEqual(["git push --force"]);
  });

  it("drops a mark whose rule was reworded, rather than reattaching it", () => {
    saveOverride(dir, { hash: ruleFingerprint(rule), decision: "rule", title: rule.title, forbids: ["git push --force"] });
    const reworded: Rule = { ...rule, text: "Never use `git push --force` on any shared branch." };
    expect(ratifiedForbids(loadOverrides(dir), reworded)).toEqual([]);
  });

  it("ignores a mark naming a literal the rule does not contain", () => {
    // Guards against a stale mark surviving a partial edit and blocking on
    // something the rule no longer mentions.
    saveOverride(dir, { hash: ruleFingerprint(rule), decision: "rule", title: rule.title, forbids: ["rm -rf /"] });
    expect(ratifiedForbids(loadOverrides(dir), rule)).toEqual([]);
  });

  it("writes nothing when only reading", () => {
    loadOverrides(dir);
    expect(() => loadOverrides(dir)).not.toThrow();
  });
});
