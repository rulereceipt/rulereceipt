import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPathScope, parseClaudeMd } from "../src/parsers/readClaudeMd.js";
import { ruleWasLoaded, touchedPaths, globToRegExp } from "../src/checks/pathScope.js";
import { evaluateSession } from "../src/evaluate.js";
import type { Rule, TranscriptEvent, CheckResult } from "../src/types.js";

const t = "2026-09-28T00:00:00Z";
const read = (p: string): TranscriptEvent => ({ role: "assistant", kind: "tool_use", toolName: "Read", input: { file_path: p }, timestamp: t });
const bash = (c: string): TranscriptEvent => ({ role: "assistant", kind: "tool_use", toolName: "Bash", input: { command: c }, timestamp: t });
const needs = (r: Rule): CheckResult => ({ ruleId: r.id, ruleTitle: r.title, ruleSource: r.source, status: "UNCLEAR", needsHuman: true, evidence: "" });

describe("readPathScope", () => {
  it("reads a Claude Code YAML list", () => {
    expect(readPathScope('---\ndescription: x\npaths:\n  - "skills/**"\n  - src/*.ts\n---\n# r')).toEqual(["skills/**", "src/*.ts"]);
  });
  it("reads an inline array and a comma list", () => {
    expect(readPathScope('---\npaths: ["src/**/*.ts", "a.md"]\n---\n')).toEqual(["src/**/*.ts", "a.md"]);
    expect(readPathScope("---\nglobs: **/*.ts, **/*.tsx\n---\n")).toEqual(["**/*.ts", "**/*.tsx"]);
  });
  it("treats alwaysApply, always_on, empty and match-all as unscoped", () => {
    expect(readPathScope("---\nglobs: src/*.ts\nalwaysApply: true\n---\n")).toBeUndefined();
    expect(readPathScope("---\ntrigger: always_on\nglobs: a/*\n---\n")).toBeUndefined();
    expect(readPathScope("---\nglobs: []\n---\n")).toBeUndefined();
    expect(readPathScope("---\nglobs: \n---\n")).toBeUndefined();
    expect(readPathScope("---\nglobs: **/*\n---\n")).toBeUndefined();
    expect(readPathScope("# no frontmatter\n- Never x")).toBeUndefined();
  });
});

describe("glob matching", () => {
  it("handles **, *, braces and suffix matching of absolute paths", () => {
    expect(globToRegExp("src/**/*.ts").test("src/a/b.ts")).toBe(true);
    expect(globToRegExp("src/**/*.ts").test("src/b.ts")).toBe(true);
    expect(ruleWasLoaded(["**/*.{ts,tsx}"], ["/Users/x/repo/app/page.tsx"])).toBe(true);
    expect(ruleWasLoaded(["src/core/bridge/**"], ["/Users/x/repo/src/core/bridge/a.ts"])).toBe(true);
    expect(ruleWasLoaded(["src/core/bridge/**"], ["/Users/x/repo/src/core/other/a.ts"])).toBe(false);
    expect(ruleWasLoaded(["**/*.py"], ["/r/a.pyc"])).toBe(false);
  });
  it("only counts file tools, not shell mentions", () => {
    expect(touchedPaths([read("/r/a.ts"), bash("cat /r/b.py")])).toEqual(["/r/a.ts"]);
  });
});

describe("evaluateSession with a path-scoped rule", () => {
  const dir = mkdtempSync(join(tmpdir(), "rr-scope-"));
  const file = join(dir, "db.md");
  writeFileSync(file, '---\npaths: ["db/**"]\n---\n- Never run `git push --force`\n');
  const rules = parseClaudeMd(file, "project");

  it("is not applicable when no matching file was touched", async () => {
    const { results } = await evaluateSession(dir, rules, [read("/r/web/a.ts"), bash("git push --force")], false, needs);
    expect(results).toHaveLength(1);
    expect(results[0].status).not.toBe("FAIL");
    expect(results[0].reason).toBe("path_scope_not_loaded");
  });
  it("is checked normally once a matching file was touched", async () => {
    const { results } = await evaluateSession(dir, rules, [read("/r/db/schema.sql"), bash("git push --force")], false, needs);
    expect(results[0].reason).toBeUndefined();
  });
});
