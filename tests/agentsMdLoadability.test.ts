import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { loadRules, describeRuleSources, projectInstructionsSetting } from "../src/rules.js";
import { auditProject } from "../src/audit.js";

/**
 * AGENTS.md loadability is version- AND setting-aware (Claude Code 2.1.277+:
 * /config "Project instructions" = claude-md-or-agents-md | claude-md-and-agents-md
 * | claude-md | managed-only). We can only state definitely that an AGENTS.md
 * beside a CLAUDE.md is "not loaded" when we can read that setting. When we
 * can't (the usual case — it's an in-app setting), we say "may not be loaded",
 * never a flat "not loaded". No false statements.
 */
let dir: string, home: string, prevHome: string | undefined, prevCfg: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rr-agents-"));
  home = mkdtempSync(join(tmpdir(), "rr-agents-home-"));
  prevHome = process.env.HOME; prevCfg = process.env.CLAUDE_CONFIG_DIR;
  process.env.HOME = home; process.env.USERPROFILE = home; delete process.env.CLAUDE_CONFIG_DIR;
  writeFileSync(join(dir, "CLAUDE.md"), "## C\n- claude-rule-marker\n");
  writeFileSync(join(dir, "AGENTS.md"), "## A\n- agents-rule-marker\n");
});
afterEach(() => {
  process.env.HOME = prevHome;
  if (prevCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prevCfg;
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});
const setSetting = (value: string) => {
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify({ projectInstructions: value }) + "\n");
};
const agentsEntry = () => describeRuleSources(dir).find((g) => basename(g.path) === "AGENTS.md");
const hasAgentsRule = () => loadRules(dir).some((r) => r.text.includes("agents-rule-marker"));

describe("AGENTS.md loadability — setting-aware, honest when unknown", () => {
  it("UNKNOWN setting: shadowed but UNCERTAIN, and says 'may not be loaded' (never flat 'not loaded')", () => {
    expect(projectInstructionsSetting(dir)).toBe("unknown");
    const e = agentsEntry()!;
    expect(e.status).toBe("shadowed");
    expect(e.uncertain).toBe(true);
    expect(e.note).toMatch(/may not be loaded/i);
    // The audit diagnostic must hedge, not assert.
    const diag = auditProject(dir).diagnostics.find((d) => d.id === "shadowed-file" && /AGENTS\.md/.test(d.message));
    expect(diag?.message).toMatch(/may not be loaded/i);
    expect(diag?.message).not.toMatch(/is present but not loaded/i);
  });

  it("claude-md-and-agents-md: AGENTS.md is LOADED and its rules are checked", () => {
    setSetting("claude-md-and-agents-md");
    expect(projectInstructionsSetting(dir)).toBe("both");
    expect(agentsEntry()!.status).toBe("loaded");
    expect(hasAgentsRule()).toBe(true);
  });

  it("claude-md: AGENTS.md is confidently shadowed (not uncertain)", () => {
    setSetting("claude-md");
    expect(projectInstructionsSetting(dir)).toBe("claude-only");
    const e = agentsEntry()!;
    expect(e.status).toBe("shadowed");
    expect(e.uncertain).toBeFalsy();
    expect(hasAgentsRule()).toBe(false);
  });

  it("claude-md-or-agents-md (explicit default): shadowed, confident, not uncertain", () => {
    setSetting("claude-md-or-agents-md");
    expect(projectInstructionsSetting(dir)).toBe("claude-wins");
    const e = agentsEntry()!;
    expect(e.status).toBe("shadowed");
    expect(e.uncertain).toBeFalsy();
  });

  it("the detector is robust to the exact key name (scans values)", () => {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify({ some: { nested: "claude-md-and-agents-md" } }) + "\n");
    expect(projectInstructionsSetting(dir)).toBe("both");
  });
});
