import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRules } from "../src/rules.js";

/**
 * OpenCode's documented rule-file set (opencode.ai/docs/rules, verified
 * 2026-10-08, and matching a real 1.18.35 session):
 *   project (up the tree): AGENTS.md primary, CLAUDE.md only where no AGENTS.md
 *   global: ~/.config/opencode/AGENTS.md, plus ~/.claude/CLAUDE.md for Claude
 *           Code compatibility (ON by default, off via OPENCODE_DISABLE_CLAUDE_CODE)
 * It must NOT read GEMINI.md, .cursorrules, Copilot or Windsurf files — checking
 * a session against a file OpenCode never loads would be a false accusation.
 */
describe("OpenCode rule scoping", () => {
  let proj = "", home = "", prevHome: string | undefined, prevXdg: string | undefined, prevDisable: string | undefined;
  const titles = (agent: string) => loadRules(proj, agent).map((r) => `${r.title} ${r.text}`);
  const has = (ts: string[], needle: string) => ts.some((t) => t.includes(needle));

  beforeEach(() => {
    proj = mkdtempSync(join(tmpdir(), "rr-ocscope-"));
    home = mkdtempSync(join(tmpdir(), "rr-ocscope-home-"));
    prevHome = process.env.HOME; prevXdg = process.env.XDG_CONFIG_HOME; prevDisable = process.env.OPENCODE_DISABLE_CLAUDE_CODE;
    process.env.HOME = home; process.env.USERPROFILE = home;
    delete process.env.XDG_CONFIG_HOME; // use ~/.config
    delete process.env.OPENCODE_DISABLE_CLAUDE_CODE;

    mkdirSync(join(proj, ".git"));
    writeFileSync(join(proj, "AGENTS.md"), "- Never push to main without asking me first.\n");
    writeFileSync(join(proj, "CLAUDE.md"), "- Project claude fallback rule.\n");
    writeFileSync(join(proj, "GEMINI.md"), "- Gemini only rule.\n");
    writeFileSync(join(proj, ".cursorrules"), "- Cursor only rule.\n");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "CLAUDE.md"), "- Global claude compat rule.\n");
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    writeFileSync(join(home, ".config", "opencode", "AGENTS.md"), "- Global opencode rule.\n");
  });
  afterEach(() => {
    process.env.HOME = prevHome; if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevDisable === undefined) delete process.env.OPENCODE_DISABLE_CLAUDE_CODE; else process.env.OPENCODE_DISABLE_CLAUDE_CODE = prevDisable;
    rmSync(proj, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
  });

  it("loads project AGENTS.md and both OpenCode globals", () => {
    const ts = titles("opencode");
    expect(has(ts, "Never push to main without asking me first.")).toBe(true); // project AGENTS.md
    expect(has(ts, "Global opencode rule.")).toBe(true);                        // ~/.config/opencode/AGENTS.md
    expect(has(ts, "Global claude compat rule.")).toBe(true);                   // ~/.claude/CLAUDE.md (compat, default on)
  });

  it("does NOT load GEMINI.md / .cursorrules / project CLAUDE.md (AGENTS.md wins)", () => {
    const ts = titles("opencode");
    expect(has(ts, "Gemini only rule.")).toBe(false);
    expect(has(ts, "Cursor only rule.")).toBe(false);
    expect(has(ts, "Project claude fallback rule.")).toBe(false); // CLAUDE.md is fallback-only; AGENTS.md present
  });

  it("CLAUDE.md IS loaded as the fallback when there is no AGENTS.md", () => {
    rmSync(join(proj, "AGENTS.md"));
    const ts = titles("opencode");
    expect(has(ts, "Project claude fallback rule.")).toBe(true);
    expect(has(ts, "Gemini only rule.")).toBe(false); // still never GEMINI.md
  });

  it("OPENCODE_DISABLE_CLAUDE_CODE=1 drops the ~/.claude/CLAUDE.md compat global", () => {
    process.env.OPENCODE_DISABLE_CLAUDE_CODE = "1";
    const ts = titles("opencode");
    expect(has(ts, "Global claude compat rule.")).toBe(false);
    expect(has(ts, "Global opencode rule.")).toBe(true); // the opencode global still loads
  });

  it("contrast: as claude-code it WOULD pull the global ~/.claude but not the opencode global", () => {
    // Guards against the opencode branch leaking into the claude path.
    const ts = titles("claude-code");
    expect(has(ts, "Global claude compat rule.")).toBe(true);
    expect(has(ts, "Global opencode rule.")).toBe(false);
  });
});
