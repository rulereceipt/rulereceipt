import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseClaudeMd } from "../src/parsers/claudeMdParser.js";

const REAL_GLOBAL_CLAUDE_MD = join(homedir(), ".claude", "CLAUDE.md");

describe("parseClaudeMd against the real global CLAUDE.md", () => {
  it("finds more than one rule", () => {
    const rules = parseClaudeMd(REAL_GLOBAL_CLAUDE_MD, "global");
    expect(rules.length).toBeGreaterThan(1);
  });

  it("does not assume sequential numbering (real file skips rule 12)", () => {
    const rules = parseClaudeMd(REAL_GLOBAL_CLAUDE_MD, "global");
    const ids = rules.map((r) => r.id);
    // proves the parser reads whatever number is actually there, not a
    // generated 1..N sequence — this is the real, messy input case
    expect(ids).toContain("11");
    expect(ids).toContain("13");
    expect(ids).not.toContain("12");
  });

  it("captures the title text correctly for a known rule", () => {
    const rules = parseClaudeMd(REAL_GLOBAL_CLAUDE_MD, "global");
    const rule1 = rules.find((r) => r.id === "1");
    expect(rule1?.title).toBe("Evidence or it didn't happen");
  });

  it("captures multi-line body text, not just the first line", () => {
    const rules = parseClaudeMd(REAL_GLOBAL_CLAUDE_MD, "global");
    const rule1 = rules.find((r) => r.id === "1");
    expect(rule1?.text.split("\n").length).toBeGreaterThan(1);
  });

  it("tags every parsed rule with the given source", () => {
    const rules = parseClaudeMd(REAL_GLOBAL_CLAUDE_MD, "global");
    expect(rules.every((r) => r.source === "global")).toBe(true);
  });

  // proves this test can actually fail, not just pass by construction
  it("FAILS if a rule known not to exist is searched for (sanity check on the test itself)", () => {
    const rules = parseClaudeMd(REAL_GLOBAL_CLAUDE_MD, "global");
    const fake = rules.find((r) => r.id === "9999");
    expect(fake).toBeUndefined();
  });

  it("returns an empty array, not a throw, for a missing file", () => {
    const rules = parseClaudeMd("/definitely/does/not/exist/CLAUDE.md", "project");
    expect(rules).toEqual([]);
  });
});
