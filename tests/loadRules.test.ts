import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadRules } from "../src/rules.js";

// Same mocking approach as tests/transcriptParser.test.ts, and the same
// underlying fix: loadRules' global-CLAUDE.md lookup had the identical
// ".claude vs .claude-office" gap as findLatestSessionFile did, since both
// hardcoded a single home-dir name. Fixed by reusing
// findClaudeHomeDirNames() in both places.
const homeState = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  homeState.current = actual.homedir();
  return { ...actual, homedir: () => homeState.current };
});

describe("loadRules collects global CLAUDE.md from every .claude*-prefixed home dir", () => {
  let tempHome: string;
  let projectDir: string;
  const realHome = homeState.current;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "rulereceipt-loadrules-home-"));
    projectDir = mkdtempSync(join(tmpdir(), "rulereceipt-loadrules-project-"));
    homeState.current = tempHome;
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
    homeState.current = realHome;
  });

  // marker-text based rather than asserting an exact title, since exact
  // title derivation from markdown headings/bullets is claudeMdParser's own
  // concern (tested separately in claudeMdParser.test.ts) — this only needs
  // to prove WHICH directories loadRules actually reads from.
  function writeGlobalClaudeMd(homeDirName: string, marker: string) {
    const dir = join(tempHome, homeDirName);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "CLAUDE.md"), `## Rule\n- ${marker}\n`);
  }

  function hasMarker(rules: ReturnType<typeof loadRules>, marker: string, source: "global" | "project") {
    return rules.some((r) => r.source === source && (r.title.includes(marker) || r.text.includes(marker)));
  }

  it("returns nothing when no global CLAUDE.md exists anywhere and no project rules either", () => {
    expect(loadRules(projectDir)).toEqual([]);
  });

  it("finds a global CLAUDE.md under the standard ~/.claude location", () => {
    writeGlobalClaudeMd(".claude", "standard-marker");
    expect(hasMarker(loadRules(projectDir), "standard-marker", "global")).toBe(true);
  });

  // the real gap: a hosted/office variant's own global CLAUDE.md must
  // also be found, not just the standard one
  it("finds a global CLAUDE.md under a non-standard .claude-office location", () => {
    writeGlobalClaudeMd(".claude-office", "office-marker");
    expect(hasMarker(loadRules(projectDir), "office-marker", "global")).toBe(true);
  });

  it("collects global rules from BOTH locations when both exist, not just one", () => {
    writeGlobalClaudeMd(".claude", "standard-marker");
    writeGlobalClaudeMd(".claude-office", "office-marker");
    const rules = loadRules(projectDir);
    expect(hasMarker(rules, "standard-marker", "global")).toBe(true);
    expect(hasMarker(rules, "office-marker", "global")).toBe(true);
  });

  it("still finds project-level CLAUDE.md alongside global rules from any home dir", () => {
    writeGlobalClaudeMd(".claude-office", "office-marker");
    writeFileSync(join(projectDir, "CLAUDE.md"), "## Rule\n- project-marker\n");
    const rules = loadRules(projectDir);
    expect(hasMarker(rules, "office-marker", "global")).toBe(true);
    expect(hasMarker(rules, "project-marker", "project")).toBe(true);
  });
});
