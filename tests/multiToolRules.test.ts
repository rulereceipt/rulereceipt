import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadRules } from "../src/rules.js";

/**
 * Multi-tool rule-file detection (2026-09-26): CLAUDE.md is one convention
 * among several. Cursor (.cursor/rules/*.mdc, legacy .cursorrules), GitHub
 * Copilot (.github/copilot-instructions.md) and Windsurf (.windsurfrules) are
 * all plain files on disk and should be read too — a rule the project wrote
 * is a rule to check, and silently ignoring one is the "clean report on rules
 * never opened" failure rules.ts already guards against.
 */
const homeState = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  homeState.current = actual.homedir();
  return { ...actual, homedir: () => homeState.current };
});

describe("loadRules reads non-Claude rule-file conventions", () => {
  let tempHome: string;
  let project: string;
  const realHome = homeState.current;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "rr-mt-home-"));
    project = mkdtempSync(join(tmpdir(), "rr-mt-proj-"));
    homeState.current = tempHome;
    mkdirSync(join(project, ".git")); // stop the upward walk here
  });
  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
    homeState.current = realHome;
  });

  const has = (marker: string) =>
    loadRules(project).some((r) => r.source === "project" && (r.title.includes(marker) || r.text.includes(marker)));

  it("reads legacy .cursorrules", () => {
    writeFileSync(join(project, ".cursorrules"), "## Style\n- cursorlegacy-marker\n");
    expect(has("cursorlegacy-marker")).toBe(true);
  });

  it("reads .cursor/rules/*.mdc", () => {
    mkdirSync(join(project, ".cursor", "rules"), { recursive: true });
    writeFileSync(join(project, ".cursor", "rules", "style.mdc"), "## Style\n- cursormdc-marker\n");
    expect(has("cursormdc-marker")).toBe(true);
  });

  it("reads .github/copilot-instructions.md", () => {
    mkdirSync(join(project, ".github"), { recursive: true });
    writeFileSync(join(project, ".github", "copilot-instructions.md"), "## Rules\n- copilot-marker\n");
    expect(has("copilot-marker")).toBe(true);
  });

  it("reads .windsurfrules", () => {
    writeFileSync(join(project, ".windsurfrules"), "## Rules\n- windsurf-marker\n");
    expect(has("windsurf-marker")).toBe(true);
  });

  it("modern .cursor/rules/ SHADOWS legacy .cursorrules (Cursor deprecated the single file)", () => {
    mkdirSync(join(project, ".cursor", "rules"), { recursive: true });
    writeFileSync(join(project, ".cursor", "rules", "style.mdc"), "## Style\n- modern-marker\n");
    writeFileSync(join(project, ".cursorrules"), "## Style\n- legacy-marker\n");
    expect(has("modern-marker")).toBe(true);
    expect(has("legacy-marker")).toBe(false);
  });

  it("strips YAML frontmatter in a .mdc file rather than turning it into a rule", () => {
    mkdirSync(join(project, ".cursor", "rules"), { recursive: true });
    writeFileSync(
      join(project, ".cursor", "rules", "fm.mdc"),
      "---\ndescription: some cursor metadata\nglobs: **/*.ts\nalwaysApply: true\n---\n\n## Style\n- realmdc-marker\n"
    );
    expect(has("realmdc-marker")).toBe(true);
    // The frontmatter keys must not surface as rules.
    expect(has("alwaysApply")).toBe(false);
    expect(has("globs")).toBe(false);
  });

  it("reads GEMINI.md (Gemini CLI)", () => {
    writeFileSync(join(project, "GEMINI.md"), "## Rules\n- gemini-marker\n");
    expect(has("gemini-marker")).toBe(true);
  });

  it("reads .agents/rules/*.md (Google agy / agents-rules convention), frontmatter stripped", () => {
    mkdirSync(join(project, ".agents", "rules"), { recursive: true });
    writeFileSync(
      join(project, ".agents", "rules", "backend.md"),
      "---\ntrigger: always_on\n---\n\n## Backend\n- agentsrules-marker\n"
    );
    expect(has("agentsrules-marker")).toBe(true);
    expect(has("always_on")).toBe(false); // frontmatter is not a rule
  });

  it("still reads CLAUDE.md alongside the others", () => {
    writeFileSync(join(project, "CLAUDE.md"), "## Rules\n- claude-marker\n");
    writeFileSync(join(project, ".windsurfrules"), "## Rules\n- windsurf-too\n");
    expect(has("claude-marker")).toBe(true);
    expect(has("windsurf-too")).toBe(true);
  });
});
