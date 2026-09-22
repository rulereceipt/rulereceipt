import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shadowedAgentsMd } from "../src/shadowedAgents.js";
import { buildInitGuidance } from "../src/init.js";

/**
 * Since 2026-09-19 Claude Code reads AGENTS.md only when a level has no
 * CLAUDE.md; with both present the AGENTS.md is silently ignored. So rules a
 * user put in that AGENTS.md govern nothing, and RuleReceipt should say so.
 */
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rr-shadow-"));
  // a .git so the upward walk stops here and never reaches the real repo
  mkdirSync(join(dir, ".git"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("shadowedAgentsMd", () => {
  it("flags an AGENTS.md sitting next to a CLAUDE.md", () => {
    writeFileSync(join(dir, "CLAUDE.md"), "# rules\nNever push to main.");
    writeFileSync(join(dir, "AGENTS.md"), "# rules\nAlways run tests.");
    const out = shadowedAgentsMd(dir);
    expect(out).toHaveLength(1);
    expect(out[0].agents).toBe(join(dir, "AGENTS.md"));
    expect(out[0].shadowedBy).toBe(join(dir, "CLAUDE.md"));
  });

  it("does NOT flag an AGENTS.md that is alone (Claude Code reads it)", () => {
    writeFileSync(join(dir, "AGENTS.md"), "# rules\nAlways run tests.");
    expect(shadowedAgentsMd(dir)).toHaveLength(0);
  });

  it("does NOT flag a lone CLAUDE.md", () => {
    writeFileSync(join(dir, "CLAUDE.md"), "# rules\nNever push to main.");
    expect(shadowedAgentsMd(dir)).toHaveLength(0);
  });

  it("flags the .claude/ subdirectory pair too", () => {
    mkdirSync(join(dir, ".claude"));
    writeFileSync(join(dir, ".claude", "CLAUDE.md"), "x");
    writeFileSync(join(dir, ".claude", "AGENTS.md"), "y");
    const out = shadowedAgentsMd(dir);
    expect(out.some((s) => s.agents === join(dir, ".claude", "AGENTS.md"))).toBe(true);
  });
});

describe("init surfaces the shadow warning", () => {
  const base = { hasClaudeMd: true, hasAgentsMd: true, hookInstalled: true, hasApiKey: true };
  it("prints the warning when an AGENTS.md is shadowed", () => {
    const text = buildInitGuidance({ ...base, shadowedAgents: ["/proj/AGENTS.md"] });
    expect(text).toMatch(/never reads|ignores it/i);
    expect(text).toContain("/proj/AGENTS.md");
  });
  it("prints no warning when nothing is shadowed", () => {
    const text = buildInitGuidance({ ...base, shadowedAgents: [] });
    expect(text).not.toMatch(/Claude Code ignores it/i);
  });
});
