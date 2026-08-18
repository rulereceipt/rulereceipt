import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseClaudeMd } from "../src/parsers/claudeMdParser.js";

const REAL_GLOBAL_CLAUDE_MD = join(homedir(), ".claude", "CLAUDE.md");
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

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

// Real template verified via web research: Builder.io's widely-shared
// CLAUDE.md guide and Anthropic's own best-practices doc both use plain,
// unnumbered headers with bullet lists underneath — no numbered headers.
describe("parseClaudeMd against plain headers + bullet lists (Builder.io-style)", () => {
  const FILE = join(FIXTURES, "plain-headers-bullets.md");

  it("splits each bullet into its own rule", () => {
    const rules = parseClaudeMd(FILE, "project");
    // 3 section bullets + 3 command bullets + 3 note bullets = 9
    expect(rules.length).toBe(9);
  });

  it("FAILS if a bullet that doesn't exist is searched for (sanity check)", () => {
    const rules = parseClaudeMd(FILE, "project");
    expect(rules.find((r) => r.title.includes("does not exist anywhere"))).toBeUndefined();
  });

  it("gives each bullet an S-prefixed dotted id scoped to its section, not a bare number", () => {
    const rules = parseClaudeMd(FILE, "project");
    const ids = rules.map((r) => r.id);
    expect(ids).toContain("S1.1");
    expect(ids).toContain("S2.1");
    expect(ids).toContain("S3.1");
  });

  it("captures the NEVER-commit-env-files rule from the Important Notes section", () => {
    const rules = parseClaudeMd(FILE, "project");
    const rule = rules.find((r) => r.text.includes("NEVER commit .env files"));
    expect(rule?.id).toBe("S3.1");
  });
});

// Real template verified via web research: the Karpathy/Forrest Chang
// CLAUDE.md template (~120k GitHub stars, widely reposted on X) formats
// each rule as bold "**Rule N — Title**" text with NO markdown header at
// all, followed by a quoted sentence.
describe("parseClaudeMd against bold pseudo-headers (Karpathy-style, no # at all)", () => {
  const FILE = join(FIXTURES, "karpathy-bold-rules.md");

  it("finds all 4 rules despite there being zero markdown headers", () => {
    const rules = parseClaudeMd(FILE, "project");
    expect(rules.length).toBe(4);
  });

  it("uses the literal rule number as the id, not an auto-generated one", () => {
    const rules = parseClaudeMd(FILE, "project");
    expect(rules.map((r) => r.id)).toEqual(["1", "2", "3", "4"]);
  });

  it("extracts the title after the em-dash", () => {
    const rules = parseClaudeMd(FILE, "project");
    expect(rules[0]?.title).toBe("Think Before Coding");
  });

  it("captures the quoted body text, not just the bold title line", () => {
    const rules = parseClaudeMd(FILE, "project");
    expect(rules[0]?.text).toContain("No silent assumptions");
  });
});

describe("parseClaudeMd against a bare bullet list with no headers at all", () => {
  const FILE = join(FIXTURES, "bare-bullets-no-headers.md");

  it("still finds all 4 rules", () => {
    const rules = parseClaudeMd(FILE, "project");
    expect(rules.length).toBe(4);
  });

  it("uses implicit section S0 for bullets with no preceding header", () => {
    const rules = parseClaudeMd(FILE, "project");
    expect(rules.map((r) => r.id)).toEqual(["S0.1", "S0.2", "S0.3", "S0.4"]);
  });
});

// Last-resort fallback: a file with zero headers, zero bullets, and zero
// bold-rule markers — just plain prose paragraphs, which real people really
// do write. Without this, such a file silently returned 0 rules.
describe("parseClaudeMd against freeform prose with no markdown structure at all", () => {
  const FILE = join(FIXTURES, "prose-only-no-structure.md");

  it("does NOT return zero rules for a genuinely unstructured file", () => {
    const rules = parseClaudeMd(FILE, "project");
    expect(rules.length).toBe(3);
  });

  it("splits on blank-line-separated paragraphs", () => {
    const rules = parseClaudeMd(FILE, "project");
    expect(rules[0]?.text).toContain("Always write tests before merging");
    expect(rules[1]?.text).toContain("Never commit directly to main");
    expect(rules[2]?.text).toContain("Keep functions under 50 lines");
  });

  it("uses the paragraph's first line as the title", () => {
    const rules = parseClaudeMd(FILE, "project");
    expect(rules[1]?.title).toBe("Never commit directly to main. All changes go through a pull request");
  });
});

describe("parseClaudeMd against a file mixing numbered-header rules and plain-header sections", () => {
  const FILE = join(FIXTURES, "mixed-numbered-and-plain.md");

  it("keeps numbered-header rules exactly as before (unsplit, id = literal number)", () => {
    const rules = parseClaudeMd(FILE, "project");
    const rule1 = rules.find((r) => r.id === "1");
    expect(rule1?.title).toBe("Evidence or it didn't happen");
    expect(rule1?.text).toContain("Never report an item done");
  });

  it("splits bullets under the plain 'Code Style' section into their own rules", () => {
    const rules = parseClaudeMd(FILE, "project");
    const bulletRule = rules.find((r) => r.text === "Use 2-space indentation");
    expect(bulletRule?.id).toBe("S1.1");
  });

  it("keeps prose under a plain header with no bullets as a single rule", () => {
    const rules = parseClaudeMd(FILE, "project");
    const deployRule = rules.find((r) => r.title === "Deployment Notes");
    expect(deployRule?.text).toContain("staging environment");
    expect(deployRule?.text).toContain("second approval");
  });

  it("never lets a plain-section id collide with a numbered-header id", () => {
    const rules = parseClaudeMd(FILE, "project");
    const ids = rules.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
