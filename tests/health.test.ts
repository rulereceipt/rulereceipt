import { describe, it, expect } from "vitest";
import { runHealth, findContradictions, findDuplicates } from "../src/health.js";
import type { Rule } from "../src/types.js";

/**
 * `rulereceipt health` — a deterministic, pre-flight lint of the rules against
 * EACH OTHER (contradiction, duplicate), separate from any session verdict.
 *
 * The trust bar is tighter here than anywhere: a health finding criticises the
 * user's rules file with no session to blame, so every lint fires only on
 * something it is certain about. These tests pin both directions — the true
 * positives AND the cases that must stay silent (the false-alarm guards).
 */
const R = (id: string, title: string, text: string, source: "global" | "project" = "project"): Rule => ({ id, title, text, source });

describe("health — contradictions (same distinctive literal, opposite explicit polarity)", () => {
  it("flags a literal required by one rule and forbidden by another", () => {
    const f = findContradictions([
      R("1", "Lockfile on", "Always pass `--frozen-lockfile` when installing."),
      R("2", "Lockfile off", "Never use `--frozen-lockfile` here."),
    ]);
    expect(f).toHaveLength(1);
    expect(f[0].subject).toBe("--frozen-lockfile");
  });

  it("flags opposite polarity on the same branch", () => {
    const f = findContradictions([
      R("1", "No main", "Never push to the `release` branch."),
      R("2", "Yes main", "Always push to the `release` branch after tests."),
    ]);
    expect(f).toHaveLength(1);
  });

  // False-alarm guards — these MUST stay silent.
  it("does NOT flag a bare common word (test) as a contradiction", () => {
    // "never skip `test`" vs "always run `test`" are about the same noun, not a
    // require/forbid conflict; `test` is not distinctive, so it is never compared.
    expect(findContradictions([
      R("1", "a", "Never skip `test`."),
      R("2", "b", "Always run `test`."),
    ])).toHaveLength(0);
  });

  it("does NOT flag when a polarity was only inferred (bare imperative)", () => {
    // "Use `--flag`" infers require; it must not manufacture a conflict with a
    // real prohibition — only explicit polarities are compared.
    expect(findContradictions([
      R("1", "a", "Use `--cache-dir`."),
      R("2", "b", "Never use `--cache-dir`."),
    ]).length).toBeLessThanOrEqual(0);
  });

  it("does NOT flag a conditionally-scoped forbid (routed to judgment, never compared)", () => {
    expect(findContradictions([
      R("1", "a", "Always use `--prod` for deploys."),
      R("2", "b", "Never use `--prod` when you are on a feature branch."),
    ])).toHaveLength(0);
  });
});

describe("health — duplicate rules (byte-identical content)", () => {
  it("flags two rules with identical title and text", () => {
    const f = findDuplicates([
      R("1", "Testing", "Always run `npm test` before pushing."),
      R("2", "Testing", "Always run `npm test` before pushing."),
    ]);
    expect(f).toHaveLength(1);
    expect(f[0].rules.length).toBe(2);
  });

  it("flags the same rule duplicated across global and project", () => {
    expect(findDuplicates([
      R("1", "Testing", "Always run `npm test` before pushing.", "global"),
      R("2", "Testing", "Always run `npm test` before pushing.", "project"),
    ])).toHaveLength(1);
  });

  it("does NOT flag rules that merely share a title but differ in body", () => {
    expect(findDuplicates([
      R("1", "Testing", "Always run `npm test` before pushing."),
      R("2", "Testing", "Always run `npm run e2e` before releasing."),
    ])).toHaveLength(0);
  });
});

describe("health — runHealth summary", () => {
  it("counts both kinds and stays silent on a clean set", () => {
    expect(runHealth([R("1", "a", "Keep functions small.")]).findings).toHaveLength(0);
    const h = runHealth([
      R("1", "x", "Always pass `--frozen-lockfile`."),
      R("2", "y", "Never use `--frozen-lockfile`."),
      R("3", "Dup", "Always run `npm test` before pushing."),
      R("4", "Dup", "Always run `npm test` before pushing."),
    ]);
    expect(h.contradictions).toBe(1);
    expect(h.duplicates).toBe(1);
  });
});
