import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadRules, lastRuleScanInfo } from "../src/rules.js";

// Mock homedir to an empty temp home so the real ~/.claude global rules never
// bleed into these assertions (same approach as loadRules.test.ts).
const homeState = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  homeState.current = actual.homedir();
  return { ...actual, homedir: () => homeState.current };
});

// A rules scan run from a parent/workspace dir that is NOT itself a git repo
// must not wander into sibling projects (each its own git repo) and count their
// rules. Proven real 2026-11-16: running `check` from ~/Desktop/Shilpa pulled in
// 4931 rules from unrelated repos. The boundary is: the enclosing git root, or
// cwd when there is no repo — and a child directory that is its own git repo is
// a separate project, never descended into.
describe("scope: never scan sibling projects", () => {
  const realHome = homeState.current;
  let tempHome: string;
  let workspace: string;
  let siblingA: string;
  let siblingB: string;

  const markerOf = (rules: ReturnType<typeof loadRules>, needle: string) =>
    rules.some((r) => `${r.title}\n${r.text}`.includes(needle));
  const pathsUnder = (rules: ReturnType<typeof loadRules>, dir: string) =>
    rules.filter((r) => (r.sourcePath ?? "").startsWith(dir));

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "rr-scope-home-"));
    homeState.current = tempHome;
    // A workspace folder with NO .git of its own.
    workspace = mkdtempSync(join(tmpdir(), "rr-scope-workspace-"));
    // A loose rules file directly in the workspace — this one DOES apply.
    writeFileSync(join(workspace, "CLAUDE.md"), "# Workspace\n\n- Never touch WORKSPACE_OWN_MARKER.\n");
    // Two sibling projects, each its own git repo with its own rules.
    siblingA = join(workspace, "project-a");
    siblingB = join(workspace, "project-b");
    for (const [dir, marker] of [[siblingA, "SIBLING_A_MARKER"], [siblingB, "SIBLING_B_MARKER"]] as const) {
      mkdirSync(join(dir, ".git"), { recursive: true });
      writeFileSync(join(dir, "CLAUDE.md"), `# ${marker}\n\n- Never delete ${marker}.\n`);
    }
  });

  afterEach(() => {
    homeState.current = realHome;
    rmSync(tempHome, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  it("run from a non-repo parent dir: skips sibling git repos, keeps the parent's own rules", () => {
    const rules = loadRules(workspace);
    // The parent's own loose rules file still applies.
    expect(markerOf(rules, "WORKSPACE_OWN_MARKER")).toBe(true);
    // Sibling projects (separate git repos) are NOT scanned.
    expect(markerOf(rules, "SIBLING_A_MARKER")).toBe(false);
    expect(markerOf(rules, "SIBLING_B_MARKER")).toBe(false);
    expect(pathsUnder(rules, siblingA).length).toBe(0);
    expect(pathsUnder(rules, siblingB).length).toBe(0);
  });

  it("reports the scope it used: not a repo, and how many sibling projects were skipped", () => {
    loadRules(workspace);
    const info = lastRuleScanInfo();
    expect(info.scopeIsRepo).toBe(false);
    expect(info.scopeRoot).toBe(workspace);
    expect(info.siblingsSkipped).toBeGreaterThanOrEqual(2);
  });

  it("run from inside a real git repo: nested non-repo subfolder rules STILL load (nested_memory preserved)", () => {
    const repo = mkdtempSync(join(tmpdir(), "rr-scope-repo-"));
    try {
      mkdirSync(join(repo, ".git"), { recursive: true });
      writeFileSync(join(repo, "CLAUDE.md"), "# Repo\n\n- Never touch REPO_ROOT_MARKER.\n");
      const sub = join(repo, "packages", "api");
      mkdirSync(sub, { recursive: true });
      writeFileSync(join(sub, "CLAUDE.md"), "# Sub\n\n- Never delete NESTED_SUBFOLDER_MARKER.\n");
      const rules = loadRules(repo);
      expect(markerOf(rules, "REPO_ROOT_MARKER")).toBe(true);
      expect(markerOf(rules, "NESTED_SUBFOLDER_MARKER")).toBe(true);
      const info = lastRuleScanInfo();
      expect(info.scopeIsRepo).toBe(true);
      expect(info.scopeRoot).toBe(repo);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
