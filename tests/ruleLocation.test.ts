import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseClaudeMdText } from "../src/parsers/claudeMdParser.js";
import { parseClaudeMd } from "../src/parsers/readClaudeMd.js";
import { attachSourceLocation } from "../src/evaluate.js";
import { generateReport } from "../src/report/generateReport.js";
import type { CheckResult, Rule } from "../src/types.js";

/**
 * A verdict you can walk to the source of is a verdict you can trust. Each
 * checked rule carries the file it came from and the 1-based line of its
 * heading, so the report can say "CLAUDE.md:42 — Never push to main". The line
 * must survive the parser's own transforms (frontmatter stripping, HTML-comment
 * removal, setext normalization) or it is worse than no line at all.
 */
describe("rule source line tracking (parseClaudeMdText)", () => {
  it("records the 1-based line of a numbered header", () => {
    const text = ["# Title", "", "## 1. First rule", "body a", "", "## 2. Second rule", "body b"].join("\n");
    const rules = parseClaudeMdText(text, "project");
    expect(rules.find((r) => r.id === "1")?.sourceLine).toBe(3);
    expect(rules.find((r) => r.id === "2")?.sourceLine).toBe(6);
  });

  it("records the line of a plain-section bullet rule", () => {
    const text = ["## Style", "- no console.log", "- no tabs"].join("\n");
    const rules = parseClaudeMdText(text, "project");
    // bullet lines are 2 and 3
    expect(rules[0]?.sourceLine).toBe(2);
    expect(rules[1]?.sourceLine).toBe(3);
  });

  it("a multi-line HTML comment before a rule does not shift its line", () => {
    const text = ["<!--", "this is a", "three line comment", "-->", "## 1. Real rule", "body"].join("\n");
    const rules = parseClaudeMdText(text, "project");
    expect(rules.find((r) => r.id === "1")?.sourceLine).toBe(5);
  });
});

describe("rule source path + frontmatter offset (parseClaudeMd)", () => {
  it("sets sourcePath and offsets sourceLine past a frontmatter block", () => {
    const dir = mkdtempSync(join(tmpdir(), "rr-loc-"));
    const file = join(dir, "CLAUDE.md");
    // 4-line frontmatter block, then a blank, then the rule on file line 6.
    writeFileSync(file, ["---", "paths:", "  - src/**", "---", "", "## 1. Scoped rule", "body"].join("\n"));
    try {
      const rules = parseClaudeMd(file, "project");
      const r = rules.find((x) => x.id === "1");
      expect(r?.sourcePath).toBe(file);
      expect(r?.sourceLine).toBe(6);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const result = (over: Partial<CheckResult>): CheckResult => ({
  ruleId: "1",
  ruleTitle: "Never push to main",
  ruleSource: "project",
  status: "FAIL",
  evidence: "git push origin main",
  ...over,
});
const rule = (over: Partial<Rule>): Rule => ({ id: "1", title: "Never push to main", text: "", source: "project", ...over });

describe("attachSourceLocation (never points at the wrong line)", () => {
  it("attaches path + line when the (source, id, title) triple is unique", () => {
    const [r] = attachSourceLocation([result({})], [rule({ sourcePath: "/p/CLAUDE.md", sourceLine: 42 })]);
    expect(r.sourcePath).toBe("/p/CLAUDE.md");
    expect(r.sourceLine).toBe(42);
  });

  it("attaches NOTHING when two loaded rules share the same triple (ambiguous)", () => {
    const rules = [
      rule({ sourcePath: "/a/CLAUDE.md", sourceLine: 5 }),
      rule({ sourcePath: "/b/CLAUDE.md", sourceLine: 9 }),
    ];
    const [r] = attachSourceLocation([result({})], rules);
    expect(r.sourcePath).toBeUndefined();
    expect(r.sourceLine).toBeUndefined();
  });

  it("leaves a result alone when no rule matches", () => {
    const [r] = attachSourceLocation([result({ ruleTitle: "Something else" })], [rule({ sourcePath: "/p/CLAUDE.md", sourceLine: 42 })]);
    expect(r.sourcePath).toBeUndefined();
  });
});

describe("generateReport shows the rule location", () => {
  it("prints ↳ path:line under a located rule", () => {
    const out = generateReport([result({ sourcePath: "/proj/CLAUDE.md", sourceLine: 42 })], { sessionFilePath: null, ruleCount: 1 });
    expect(out).toContain("↳ /proj/CLAUDE.md:42");
  });

  it("prints no location line when the rule has none", () => {
    const out = generateReport([result({})], { sessionFilePath: null, ruleCount: 1 });
    expect(out).not.toContain("↳");
  });
});
