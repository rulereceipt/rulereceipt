import { describe, it, expect } from "vitest";
import { parseClaudeMdText } from "../src/parsers/claudeMdParser.js";
import { evidenceLineIndex } from "../src/breakContext.js";

// Bug (a): plain lines (no "- " bullets) under a plain header currently merge into
// ONE rule, so none of them get checked. They must split into separate rules.
describe("bug (a) — plain-line rules split under a plain header", () => {
  it("three imperative lines → three separate rules", () => {
    const md = `# Project rules\n\nNever push to main.\nNever edit .env files.\nRun the tests before you are done.\n`;
    const rules = parseClaudeMdText(md, "project");
    const titles = rules.map((r) => r.title);
    expect(rules.length).toBe(3);
    expect(titles).toEqual([
      "Never push to main.",
      "Never edit .env files.",
      "Run the tests before you are done.",
    ]);
    // ids stay S-prefixed and per-line source lines are right (header on line 1)
    expect(rules.map((r) => r.sourceLine)).toEqual([3, 4, 5]);
    expect(rules.every((r) => /^S\d+\.\d+$/.test(r.id))).toBe(true);
  });

  it("near-miss: one rule wrapped across two lines stays ONE rule", () => {
    const md = `# Policy\n\nNever push directly to the main branch without first opening a pull\nrequest and getting it reviewed by someone else.\n`;
    const rules = parseClaudeMdText(md, "project");
    expect(rules.length).toBe(1); // wrapped continuation (2nd line lowercase) → one rule
    expect(rules[0].text).toContain("reviewed by someone else");
  });

  it("near-miss: a described section (first line not a directive) stays ONE rule", () => {
    const md = `# Context\n\nThis project is a CLI that reads agent transcripts.\nNever delete the ledger.\n`;
    const rules = parseClaudeMdText(md, "project");
    expect(rules.length).toBe(1); // mixed/narrative → not split (safe)
  });

  it("regression: bulleted section still yields one rule per bullet", () => {
    const md = `# Rules\n\n- Never push to main.\n- Always run tests.\n`;
    const rules = parseClaudeMdText(md, "project");
    expect(rules.map((r) => r.title)).toEqual(["Never push to main.", "Always run tests."]);
  });

  it("regression: numbered headers are one rule each (bodies not line-split)", () => {
    const md = `## 1. No force pushes\n\nDo not force push.\nThis protects shared history.\n`;
    const rules = parseClaudeMdText(md, "project");
    expect(rules.length).toBe(1);
    expect(rules[0].id).toBe("1");
  });
});

// Bug (b): a file-ban FAIL must place on the timeline at its edit. Placement is by
// locating evidence text in the raw log; the file PATH is in the log even though the
// "Edit on …" sentence is constructed.
describe("bug (b) — file-ban FAIL places at its edit on the timeline", () => {
  const log = [
    `{"type":"user","message":{"role":"user","content":"ship it"}}`,
    `{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Edit","input":{"file_path":"/Users/dev/acme/.env","old_string":"A","new_string":"B"}}]}}`,
    `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}`,
  ];
  it("locates the .env edit line from the constructed evidence", () => {
    const evidence = `".env" was actually modified: Edit on /Users/dev/acme/.env`;
    const idx = evidenceLineIndex(log, evidence);
    expect(idx).toBe(1); // the Edit line, not -1 (unplaced)
  });
  it("relative path in evidence also places", () => {
    const log2 = [
      `{"x":1}`,
      `{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Write","input":{"file_path":"src/config.env"}}]}}`,
    ];
    const idx = evidenceLineIndex(log2, `"config.env" was actually modified: Write on src/config.env`);
    expect(idx).toBe(1);
  });
});
