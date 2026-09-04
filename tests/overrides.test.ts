import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ruleFingerprint,
  loadOverrides,
  saveOverride,
  clearOverride,
  staleOverrides,
  OVERRIDES_PATH,
} from "../src/overrides.js";
import type { Rule } from "../src/types.js";

/**
 * The classifier's guess about what counts as a rule is wrong in both
 * directions and cannot stop being wrong: imperative verbs are not a closed
 * class, and its word list is English-only. This project's own Rule 5 was
 * filed as documentation and never checked, because it says "say so
 * explicitly" and `say` is not on the list.
 *
 * So the classifier does not need to be right. It needs to be correctable,
 * and to STAY corrected. These tests cover the staying part.
 */

function makeRule(title: string, text = "", id = "1"): Rule {
  return { id, title, text, source: "project" };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rr-ovr-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("ruleFingerprint", () => {
  it("identifies a rule by content, not by id or position", () => {
    // The whole point. Rule ids are positional: editing a file renumbers
    // everything after the edit, and one parser fix shifted the corpus enough
    // that a seeded sample redrawn at the same seed returned 92 different
    // rules out of 100. An override keyed on position reattaches a decision
    // to a rule nobody judged.
    const a = makeRule("No silent scope changes", "Say so explicitly.", "5");
    const b = makeRule("No silent scope changes", "Say so explicitly.", "17");
    expect(ruleFingerprint(a)).toBe(ruleFingerprint(b));
  });

  it("survives reflowed whitespace but not reworded text", () => {
    const original = makeRule("Keep it short", "Lead with\nwhat broke.");
    const reflowed = makeRule("Keep it short", "Lead with what broke.");
    const reworded = makeRule("Keep it short", "Lead with what failed.");
    expect(ruleFingerprint(reflowed)).toBe(ruleFingerprint(original));
    // Different words are a different rule and deserve a fresh look.
    expect(ruleFingerprint(reworded)).not.toBe(ruleFingerprint(original));
  });

  it("distinguishes rules that differ only in title", () => {
    expect(ruleFingerprint(makeRule("A", "same body"))).not.toBe(
      ruleFingerprint(makeRule("B", "same body"))
    );
  });
});

describe("override persistence", () => {
  it("returns nothing when no overrides file exists", () => {
    expect(loadOverrides(dir).size).toBe(0);
  });

  it("round-trips a decision", () => {
    const rule = makeRule("No silent scope changes", "Say so explicitly.");
    const hash = ruleFingerprint(rule);
    saveOverride(dir, { hash, decision: "rule", title: rule.title });
    const loaded = loadOverrides(dir);
    expect(loaded.get(hash)?.decision).toBe("rule");
    expect(loaded.get(hash)?.title).toBe("No silent scope changes");
  });

  it("writes only when asked, and only to its own directory", () => {
    // `check` never writes anything; that is a stated guarantee. Saving is
    // reachable solely from an explicit command.
    expect(existsSync(join(dir, OVERRIDES_PATH))).toBe(false);
    saveOverride(dir, { hash: "abc123", decision: "notARule", title: "x" });
    expect(existsSync(join(dir, OVERRIDES_PATH))).toBe(true);
  });

  it("replaces rather than duplicates when the same rule is set twice", () => {
    saveOverride(dir, { hash: "abc123", decision: "rule", title: "x" });
    saveOverride(dir, { hash: "abc123", decision: "notARule", title: "x" });
    const loaded = loadOverrides(dir);
    expect(loaded.size).toBe(1);
    expect(loaded.get("abc123")?.decision).toBe("notARule");
  });

  it("clears an override and reports whether one was there", () => {
    saveOverride(dir, { hash: "abc123", decision: "rule", title: "x" });
    expect(clearOverride(dir, "abc123")).toBe(true);
    expect(loadOverrides(dir).size).toBe(0);
    expect(clearOverride(dir, "abc123")).toBe(false);
  });

  it("survives a corrupt overrides file instead of taking the run down", () => {
    // Losing corrections for one run is visible in the report. Losing the
    // report is not recoverable by the user.
    mkdirSync(join(dir, ".rulereceipt"), { recursive: true });
    writeFileSync(join(dir, OVERRIDES_PATH), "{ not json at all");
    expect(() => loadOverrides(dir)).not.toThrow();
    expect(loadOverrides(dir).size).toBe(0);
  });

  it("ignores entries with an unrecognised decision", () => {
    mkdirSync(join(dir, ".rulereceipt"), { recursive: true });
    writeFileSync(
      join(dir, OVERRIDES_PATH),
      JSON.stringify({ version: 1, overrides: [{ hash: "h", decision: "maybe", title: "x" }] })
    );
    expect(loadOverrides(dir).size).toBe(0);
  });

  it("stores overrides sorted, so the file diffs cleanly in review", () => {
    saveOverride(dir, { hash: "ccc", decision: "rule", title: "c" });
    saveOverride(dir, { hash: "aaa", decision: "rule", title: "a" });
    const raw = readFileSync(join(dir, OVERRIDES_PATH), "utf-8");
    expect(raw.indexOf('"aaa"')).toBeLessThan(raw.indexOf('"ccc"'));
  });
});

describe("staleOverrides", () => {
  it("names overrides whose rule is no longer present", () => {
    // A correction that stopped matching usually means the rule was reworded.
    // The user should learn that rather than assume it still applies.
    const live = makeRule("Still here", "body");
    const overrides = new Map([
      [ruleFingerprint(live), { hash: ruleFingerprint(live), decision: "rule" as const, title: "Still here" }],
      ["deadbeef0000", { hash: "deadbeef0000", decision: "rule" as const, title: "Gone away" }],
    ]);
    const stale = staleOverrides(overrides, [live]);
    expect(stale).toHaveLength(1);
    expect(stale[0].title).toBe("Gone away");
  });
});
