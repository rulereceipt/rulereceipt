import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRules, describeRuleSources } from "../src/rules.js";
import { shadowedAgentsMd } from "../src/shadowedAgents.js";
import { importTargets, stripCodeForImports } from "../src/parsers/imports.js";

/**
 * @imports: a CLAUDE.md that says `@AGENTS.md` makes AGENTS.md LOADED, not
 * shadowed. On 0.1.74 the tool said "AGENTS.md present but not loaded" (untrue)
 * and never checked those rules. These lock the fix, including the cases where
 * an @token must NOT count (code fences, code spans).
 */
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rr-imp-"));
  mkdirSync(join(dir, ".git"), { recursive: true }); // stop the level walk at this root
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const w = (name: string, body: string) => writeFileSync(join(dir, name), body);
const hasRule = (marker: string) => loadRules(dir).some((r) => `${r.title} ${r.text}`.includes(marker));
const sourceFor = (name: string) => describeRuleSources(dir).find((e) => e.path === join(dir, name));

describe("importTargets / stripCodeForImports", () => {
  it("finds an @import and resolves it against the file's directory", () => {
    expect(importTargets(join(dir, "CLAUDE.md"), "@AGENTS.md\n")).toEqual([join(dir, "AGENTS.md")]);
  });
  it("ignores an @token inside a code span", () => {
    expect(importTargets(join(dir, "CLAUDE.md"), "use `@AGENTS.md` as an example\n")).toEqual([]);
  });
  it("ignores an @token inside a fenced code block", () => {
    expect(importTargets(join(dir, "CLAUDE.md"), "```\n@AGENTS.md\n```\n")).toEqual([]);
  });
  it("does not treat an email address as an import", () => {
    expect(importTargets(join(dir, "CLAUDE.md"), "contact me@example.com\n")).toEqual([]);
  });
  it("stripCodeForImports blanks fenced blocks", () => {
    expect(stripCodeForImports("a\n```\n@x\n```\nb")).toBe("a\n\n\n\nb");
  });
});

describe("loadRules follows @imports", () => {
  it("CLAUDE.md = '@AGENTS.md' only: the imported rules ARE loaded", () => {
    w("CLAUDE.md", "@AGENTS.md\n");
    w("AGENTS.md", "## Imported\n- IMPORTEDMARKER never force-push.\n");
    expect(hasRule("IMPORTEDMARKER")).toBe(true);
  });
  it("CLAUDE.md with its own rules + @AGENTS.md: both are loaded", () => {
    w("CLAUDE.md", "## Own\n- OWNMARKER run tests.\n\n@AGENTS.md\n");
    w("AGENTS.md", "## Imported\n- IMPORTEDMARKER never force-push.\n");
    expect(hasRule("OWNMARKER")).toBe(true);
    expect(hasRule("IMPORTEDMARKER")).toBe(true);
  });
  it("nested imports load transitively", () => {
    w("CLAUDE.md", "@a.md\n");
    w("a.md", "## A\n- AMARKER x.\n\n@b.md\n");
    w("b.md", "## B\n- BMARKER y.\n");
    expect(hasRule("AMARKER")).toBe(true);
    expect(hasRule("BMARKER")).toBe(true);
  });
  it("an @import inside a code fence is NOT loaded", () => {
    w("CLAUDE.md", "## Own\n- OWNMARKER x.\n\n```\n@AGENTS.md\n```\n");
    w("AGENTS.md", "## Imported\n- FENCEDMARKER never do this.\n");
    expect(hasRule("OWNMARKER")).toBe(true);
    expect(hasRule("FENCEDMARKER")).toBe(false);
  });
});

describe("audit / shadow reporting", () => {
  it("describeRuleSources marks an imported AGENTS.md as loaded (not shadowed)", () => {
    w("CLAUDE.md", "@AGENTS.md\n");
    w("AGENTS.md", "- IMPORTEDMARKER x.\n");
    expect(sourceFor("AGENTS.md")?.status).toBe("loaded");
  });
  it("a plain shadowed AGENTS.md (no import) is still reported shadowed", () => {
    w("CLAUDE.md", "## Own\n- OWNMARKER x.\n");
    w("AGENTS.md", "- SHADOWMARKER x.\n");
    expect(sourceFor("AGENTS.md")?.status).toBe("shadowed");
    expect(hasRule("SHADOWMARKER")).toBe(false);
  });
  it("shadowedAgentsMd does NOT warn when CLAUDE.md imports AGENTS.md", () => {
    w("CLAUDE.md", "@AGENTS.md\n");
    w("AGENTS.md", "- x.\n");
    expect(shadowedAgentsMd(dir)).toHaveLength(0);
  });
  it("shadowedAgentsMd DOES warn on a real shadow (no import)", () => {
    w("CLAUDE.md", "- own.\n");
    w("AGENTS.md", "- x.\n");
    expect(shadowedAgentsMd(dir)).toHaveLength(1);
  });
});
