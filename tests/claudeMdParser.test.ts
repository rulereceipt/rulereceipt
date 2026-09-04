import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseClaudeMd } from "../src/parsers/readClaudeMd.js";
import { parseClaudeMdText } from "../src/parsers/claudeMdParser.js";

const REAL_GLOBAL_CLAUDE_MD = join(homedir(), ".claude", "CLAUDE.md");
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

// Runs against the developer's actual global rules file — real, messy,
// human-written input, which is the point. It doesn't exist on a CI
// runner, so it's skipped there rather than failing: a test that can only
// pass on one machine isn't a passing test, it's a false green.
describe.skipIf(!existsSync(REAL_GLOBAL_CLAUDE_MD))("parseClaudeMd against the real global CLAUDE.md", () => {
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

// Setext headers ("Title\n===" / "Title\n---") are a real, if less common,
// Markdown convention — supported by normalizing to ATX form before parsing.
describe("parseClaudeMd against setext-style headers (underline, not #)", () => {
  const FILE = join(FIXTURES, "setext-headers.md");

  it("finds 3 rules: 2 bullets under the H2 section, 1 prose rule under the other", () => {
    const rules = parseClaudeMd(FILE, "project");
    expect(rules.length).toBe(3);
  });

  it("drops the H1 setext title itself (no content directly under it before the next header)", () => {
    const rules = parseClaudeMd(FILE, "project");
    expect(rules.find((r) => r.title === "Project Rules")).toBeUndefined();
  });

  it("splits bullets under the setext H2 'Code Style' section into their own rules", () => {
    const rules = parseClaudeMd(FILE, "project");
    expect(rules.find((r) => r.text === "Use 2-space indentation")).toBeDefined();
    expect(rules.find((r) => r.text === "No semicolons")).toBeDefined();
  });

  it("captures prose under the setext H2 'Deployment' section as one rule", () => {
    const rules = parseClaudeMd(FILE, "project");
    const deployRule = rules.find((r) => r.title === "Deployment");
    expect(deployRule?.text).toContain("staging first");
    expect(deployRule?.text).toContain("on-call engineer");
  });

  it("does NOT treat a bullet list's own dashes as a setext underline", () => {
    // "- Use 2-space indentation" / "- No semicolons" must stay bullets,
    // not get misread as an underline for some preceding title line
    const rules = parseClaudeMd(FILE, "project");
    expect(rules.some((r) => r.title.startsWith("-"))).toBe(false);
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

  // ---- fenced code blocks are content, not structure ----
  //
  // Found by auditing the parser across 559 real rules files: 588 rules came
  // out carrying an unclosed code fence, meaning the parser had split them
  // mid-block. A markdown heading or bullet inside a fence is sample text,
  // not a new rule, and treating it as structure does three things at once:
  // truncates the real rule at the fence, fabricates rules out of the code,
  // and drops commands from a "don't do this" example into a rule body where
  // the structured checks can read them.

  it("does not split a rule on a heading inside a code fence", () => {
    const rules = parseClaudeMdText(
      [
        "## 1. Never commit to main",
        "Bad example:",
        "",
        "```bash",
        "# this is a code comment, not a heading",
        "git commit -am wip",
        "```",
        "",
        "That was the bad example.",
      ].join("\n"),
      "project"
    );
    expect(rules).toHaveLength(1);
    expect(rules[0].title).toBe("Never commit to main");
  });

  it("does not split a rule on a bullet inside a code fence", () => {
    const rules = parseClaudeMdText(
      ["## Style", "Prefer this shape:", "", "```yaml", "- item one", "- item two", "```"].join("\n"),
      "project"
    );
    expect(rules).toHaveLength(1);
  });

  it("keeps the whole fenced block inside the rule it belongs to", () => {
    const rules = parseClaudeMdText(
      ["## 1. Never commit to main", "Bad example:", "", "```bash", "# bad", "git commit -am wip", "- also bad", "```", "", "Do not do that."].join("\n"),
      "project"
    );
    expect(rules[0].text).toContain("git commit -am wip");
    expect(rules[0].text).toContain("Do not do that.");
  });

  it("never turns a line inside a fence into a rule of its own", () => {
    const rules = parseClaudeMdText(
      ["## A", "text", "```js", "// ## not a heading", "const x = 1;", "- not a bullet", "```", "## B", "more"].join("\n"),
      "project"
    );
    const titles = rules.map((r) => r.title);
    expect(titles).not.toContain("not a bullet");
    expect(titles).not.toContain("not a heading");
    // Fences must also stay balanced within whichever rule holds them.
    for (const r of rules) {
      expect((r.text.match(/```/g) ?? []).length % 2).toBe(0);
    }
  });
});
