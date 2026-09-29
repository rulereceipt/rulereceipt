import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { explainRule, findRules, renderWhy } from "../src/why.js";
import { loadRules } from "../src/rules.js";

/**
 * `why` composes data the engine already produces; these tests pin the facts it
 * reports for ONE rule: which rule it matches, where it lives, whether it's
 * checkable, whether a command it names exists, and that history is best-effort.
 */
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rr-why-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});
const claude = (body: string) => writeFileSync(join(dir, "CLAUDE.md"), body);

describe("findRules — fuzzy match", () => {
  it("matches a distinctive phrase from the rule body", () => {
    claude("## 1. Branch\nNever push straight to the main branch.\n\n## 2. Emoji\nNo emoji in output.\n");
    const rules = loadRules(dir);
    const hits = findRules(rules, "push straight to the main");
    expect(hits).toHaveLength(1);
    expect(hits[0].title.toLowerCase()).toContain("branch");
  });
  it("matches across punctuation the user won't type (commas, backticks)", () => {
    claude("## 1. Style\nWrite clean, elegant, maintainable `code`.\n");
    const hits = findRules(loadRules(dir), "clean elegant maintainable code");
    expect(hits).toHaveLength(1);
  });
  it("returns nothing for a phrase in no rule", () => {
    claude("## 1. Branch\nNever push to main.\n");
    expect(findRules(loadRules(dir), "kubernetes ingress")).toHaveLength(0);
  });
});

describe("explainRule — the facts for one rule", () => {
  it("reports location, that it loads, and that a git-branch rule is checkable", async () => {
    claude("## 1. Branch\nNever push to the `main` branch directly.\n");
    const r = await explainRule(dir, "push to the main branch directly");
    expect(r.matches).toBe(1);
    expect(r.rule!.loaded).toBe(true);
    expect(r.rule!.location).toContain("CLAUDE.md");
    expect(r.rule!.checkable).toBe(true);
    expect(r.rule!.kind).toBe("gitBranchPolicy");
  });

  it("a vague judgment rule is not checkable and carries a suggestion", async () => {
    claude("## 1. Quality\nWrite clean, elegant, maintainable code.\n");
    const r = await explainRule(dir, "clean, elegant, maintainable code");
    expect(r.rule!.checkable).toBe(false);
    expect(typeof r.rule!.suggestion).toBe("string");
  });

  it("flags a named npm script that does NOT exist", async () => {
    claude("## 1. Tests\nAlways run `npm run test:ci` before pushing.\n");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { build: "tsc" } }));
    const r = await explainRule(dir, "run `npm run test:ci` before pushing");
    expect(r.rule!.named).toEqual({ kind: "command", name: "test:ci", exists: false });
  });

  it("confirms a named npm script that DOES exist", async () => {
    claude("## 1. Tests\nAlways run `npm run build` before pushing.\n");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { build: "tsc" } }));
    const r = await explainRule(dir, "run `npm run build` before pushing");
    expect(r.rule!.named!.exists).toBe(true);
  });

  it("lists candidates when several rules match", async () => {
    claude("## 1. A\nAlways run tests before pushing.\n\n## 2. B\nNever skip running tests.\n");
    const r = await explainRule(dir, "tests");
    expect(r.matches).toBeGreaterThan(1);
    expect(r.candidates!.length).toBeGreaterThan(1);
    expect(r.rule).toBeUndefined();
  });

  it("returns matches:0 for an unknown rule", async () => {
    claude("## 1. A\nNever push to main.\n");
    const r = await explainRule(dir, "unrelated nonsense phrase");
    expect(r.matches).toBe(0);
    expect(renderWhy(r)).toContain("No rule matched");
  });

  it("history is best-effort: no proven break in a fresh project", async () => {
    claude("## 1. Branch\nNever push straight to main.\n");
    const r = await explainRule(dir, "push straight to main");
    expect(r.rule!.brokenCount).toBe(0);
    expect(renderWhy(r)).toContain("no proven break");
  });
});

describe("renderWhy — plain text", () => {
  it("shows the not-loaded reason when a file is shadowed", () => {
    const out = renderWhy({
      query: "x",
      matches: 1,
      rule: {
        id: "r1", title: "Some rule", source: "project", location: "AGENTS.md:3",
        loaded: false, loadNote: "trigger is manual — the agent does not auto-load it",
        checkable: false, kind: "judgment", brokenCount: 0, brokenDates: [], sessionsScanned: 4,
      },
    });
    expect(out).toContain("NOT loaded");
    expect(out).toContain("does not auto-load");
  });
});
