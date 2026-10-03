import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadMemoryRules } from "../src/parsers/readMemory.js";
import { loadRules } from "../src/rules.js";

/**
 * Memory as a rule source (2026-09-27). Claude Code keeps per-project memory
 * under <claude-home>/projects/<encoded-cwd>/memory/*.md, each file a
 * frontmatter block (name/description/metadata.type) + body. `feedback` and
 * `project` memories carry directives the tool should check; `user` and
 * `reference` are identity/pointers and never rules. Scoped to non-office
 * homes (project rule: never office).
 */
const homeState = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => homeState.current || actual.homedir() };
});

function memDir(home: string, homeName: string, cwd: string): string {
  const enc = cwd.replace(/\//g, "-");
  const d = join(home, homeName, "projects", enc, "memory");
  mkdirSync(d, { recursive: true });
  return d;
}
function memFile(type: string, description: string, body: string, name = "m"): string {
  return `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  type: ${type}\n---\n\n${body}\n`;
}

describe("loadMemoryRules", () => {
  let home: string;
  const cwd = "/work/proj";
  const realHome = homeState.current;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "rr-mem-home-"));
    homeState.current = home;
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    homeState.current = realHome;
  });

  it("reads a feedback memory as a rule", () => {
    const d = memDir(home, ".claude", cwd);
    writeFileSync(join(d, "always-branch.md"), memFile("feedback", "Branch before committing", "Always create a branch before committing to `main`.", "branch"));
    expect(loadMemoryRules(cwd).some((r) => /branch before committing/i.test(r.text))).toBe(true);
  });

  it("reads a project-type memory as a rule", () => {
    const d = memDir(home, ".claude", cwd);
    writeFileSync(join(d, "constraint.md"), memFile("project", "DB constraint", "Never DROP the `ledger` table under any circumstances.", "ledger"));
    expect(loadMemoryRules(cwd).some((r) => /never drop/i.test(r.text))).toBe(true);
  });

  it("skips user and reference memories (identity and pointers, not rules)", () => {
    const d = memDir(home, ".claude", cwd);
    writeFileSync(join(d, "who.md"), memFile("user", "Who the user is", "The user is the founder of the project.", "who"));
    writeFileSync(join(d, "ref.md"), memFile("reference", "Dashboard", "PostHog dashboard: https://example.com/x", "ref"));
    expect(loadMemoryRules(cwd)).toHaveLength(0);
  });

  it("skips the MEMORY.md index file", () => {
    const d = memDir(home, ".claude", cwd);
    writeFileSync(join(d, "MEMORY.md"), "- [Branch rule](always-branch.md) — hook\n");
    expect(loadMemoryRules(cwd)).toHaveLength(0);
  });

  it("does not read a non-standard home's memory unless it is configured", () => {
    // Discovery is opt-in: an employer's .claude-office (or any home that isn't
    // ~/.claude) is never read unless the user names it via
    // RULERECEIPT_CLAUDE_HOMES. Here it is not configured, so its memory is
    // invisible — which for RuleReceipt also keeps employer memory out by default.
    const d = memDir(home, ".claude-office", cwd);
    writeFileSync(join(d, "office.md"), memFile("feedback", "Office rule", "Always deploy through the office pipeline.", "office"));
    expect(loadMemoryRules(cwd)).toHaveLength(0);
  });

  it("labels memory rules as project source", () => {
    const d = memDir(home, ".claude", cwd);
    writeFileSync(join(d, "m.md"), memFile("feedback", "A rule", "Always run `npm test` before pushing.", "test"));
    expect(loadMemoryRules(cwd).every((r) => r.source === "project")).toBe(true);
  });

  it("loadRules includes memory rules alongside file rules", () => {
    const proj = mkdtempSync(join(tmpdir(), "rr-mem-proj-"));
    mkdirSync(join(proj, ".git"));
    writeFileSync(join(proj, "CLAUDE.md"), "## Rules\n- file-rule-marker\n");
    const d = memDir(home, ".claude", proj);
    writeFileSync(join(d, "m.md"), memFile("feedback", "Memory rule", "Always surface memory-rule-marker first.", "mm"));
    const rules = loadRules(proj);
    expect(rules.some((r) => /file-rule-marker/.test(r.text) || /file-rule-marker/.test(r.title))).toBe(true);
    expect(rules.some((r) => /memory-rule-marker/.test(r.text))).toBe(true);
    rmSync(proj, { recursive: true, force: true });
  });
});
