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

  // Real gap: rules were only read from the exact directory the command
  // ran in. Claude Code applies a rules file to everything beneath it, so
  // in a monorepo the root CLAUDE.md governs packages/api — running the
  // check there silently reported on a subset of the rules that applied.
  describe("nested / monorepo rules files", () => {
    it("reads a rules file from a parent directory, not just the cwd", () => {
      writeFileSync(join(projectDir, "CLAUDE.md"), "## Rule\n- root-marker\n");
      writeFileSync(join(projectDir, ".git"), "");
      const pkg = join(projectDir, "packages", "api");
      mkdirSync(pkg, { recursive: true });
      const rules = loadRules(pkg);
      expect(hasMarker(rules, "root-marker", "project")).toBe(true);
    });

    it("combines rules from every level, not just the nearest one", () => {
      writeFileSync(join(projectDir, "CLAUDE.md"), "## Rule\n- root-marker\n");
      writeFileSync(join(projectDir, ".git"), "");
      const pkg = join(projectDir, "packages", "api");
      mkdirSync(pkg, { recursive: true });
      writeFileSync(join(pkg, "CLAUDE.md"), "## Rule\n- package-marker\n");
      const rules = loadRules(pkg);
      expect(hasMarker(rules, "root-marker", "project")).toBe(true);
      expect(hasMarker(rules, "package-marker", "project")).toBe(true);
    });

    it("picks up AGENTS.md at a parent level too, not only CLAUDE.md", () => {
      writeFileSync(join(projectDir, "AGENTS.md"), "## Rule\n- agents-root-marker\n");
      writeFileSync(join(projectDir, ".git"), "");
      const pkg = join(projectDir, "packages", "web");
      mkdirSync(pkg, { recursive: true });
      expect(hasMarker(loadRules(pkg), "agents-root-marker", "project")).toBe(true);
    });

    // the guard: stopping at the repo root means an unrelated rules file
    // in a parent workspace is never pulled into this project
    it("stops at the repository root and does not climb into unrelated parents", () => {
      const outside = join(projectDir, "outside-marker-holder");
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(projectDir, "CLAUDE.md"), "## Rule\n- outside-marker\n");
      const repo = join(projectDir, "the-repo");
      mkdirSync(repo, { recursive: true });
      writeFileSync(join(repo, ".git"), "");
      writeFileSync(join(repo, "CLAUDE.md"), "## Rule\n- repo-marker\n");
      const rules = loadRules(repo);
      expect(hasMarker(rules, "repo-marker", "project")).toBe(true);
      expect(hasMarker(rules, "outside-marker", "project")).toBe(false);
    });
  });
});

/**
 * Claude Code loads more than a bare CLAUDE.md, and every location it
 * loads is a place a real rule can live.
 *
 * Found 2026-09-02 by comparing the tool against the documented load
 * order: a project with four rules files produced "1 rules checked · all
 * passed". Three files were invisible, and nothing said so — the worst
 * shape of failure this tool can have, because a clean report on rules it
 * never read is more misleading than no report at all.
 *
 * Per the docs, Claude Code reads (broadest to most specific):
 *   ~/.claude/CLAUDE.md, ~/.claude/rules/*.md,
 *   ./CLAUDE.md, ./.claude/CLAUDE.md, ./.claude/rules/*.md,
 *   ./CLAUDE.local.md, and the same set at each level up the tree.
 *
 * Managed enterprise policy paths are deliberately NOT covered: they are
 * machine-wide, org-deployed, and cannot be tested here without inventing
 * a location. That gap is stated rather than silently left.
 */
describe("reads every rules-file location Claude Code actually loads", () => {
  let dir: string;
  const realHome = homeState.current;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rulereceipt-locations-"));
    writeFileSync(join(dir, ".git"), ""); // stop the upward walk here
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    homeState.current = realHome;
  });

  const has = (rules: ReturnType<typeof loadRules>, marker: string) =>
    rules.some((r) => r.title.includes(marker) || r.text.includes(marker));

  it("reads .claude/CLAUDE.md — the documented in-project location", () => {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "CLAUDE.md"), "## Rule\n- dotclaude-marker\n");
    expect(has(loadRules(dir), "dotclaude-marker")).toBe(true);
  });

  it("reads CLAUDE.local.md — personal overrides for one repo", () => {
    writeFileSync(join(dir, "CLAUDE.local.md"), "## Rule\n- local-marker\n");
    expect(has(loadRules(dir), "local-marker")).toBe(true);
  });

  it("reads .claude/rules/*.md — team rules split into files", () => {
    mkdirSync(join(dir, ".claude", "rules"), { recursive: true });
    writeFileSync(join(dir, ".claude", "rules", "testing.md"), "## Rule\n- teamrules-marker\n");
    writeFileSync(join(dir, ".claude", "rules", "style.md"), "## Rule\n- stylerules-marker\n");
    const rules = loadRules(dir);
    expect(has(rules, "teamrules-marker")).toBe(true);
    expect(has(rules, "stylerules-marker")).toBe(true);
  });

  it("reads ~/.claude/rules/*.md — personal rules across all projects", () => {
    const home = mkdtempSync(join(tmpdir(), "rulereceipt-locations-home-"));
    homeState.current = home;
    try {
      mkdirSync(join(home, ".claude", "rules"), { recursive: true });
      writeFileSync(join(home, ".claude", "rules", "habits.md"), "## Rule\n- globalrules-marker\n");
      expect(has(loadRules(dir), "globalrules-marker")).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // The whole point: all of them together, none silently dropped.
  it("reads ALL of them in one project, not just the first it finds", () => {
    writeFileSync(join(dir, "CLAUDE.md"), "## Rule\n- root-marker\n");
    mkdirSync(join(dir, ".claude", "rules"), { recursive: true });
    writeFileSync(join(dir, ".claude", "CLAUDE.md"), "## Rule\n- dotclaude-marker\n");
    writeFileSync(join(dir, ".claude", "rules", "a.md"), "## Rule\n- teamrules-marker\n");
    writeFileSync(join(dir, "CLAUDE.local.md"), "## Rule\n- local-marker\n");
    const rules = loadRules(dir);
    for (const m of ["root-marker", "dotclaude-marker", "teamrules-marker", "local-marker"]) {
      expect(has(rules, m), `missing ${m}`).toBe(true);
    }
  });

  it("ignores non-markdown files sitting in a rules directory", () => {
    mkdirSync(join(dir, ".claude", "rules"), { recursive: true });
    writeFileSync(join(dir, ".claude", "rules", "notes.txt"), "## Rule\n- txt-marker\n");
    expect(has(loadRules(dir), "txt-marker")).toBe(false);
  });
});
