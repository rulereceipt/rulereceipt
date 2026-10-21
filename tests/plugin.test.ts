import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * The self-hosted Claude Code plugin + marketplace. `claude plugin validate` is
 * the authoritative check (run in CI/release); this pins the fields RuleReceipt
 * relies on so a regression (wrong source path, a resurrected auto-installed hook,
 * a missing command or skill) fails the suite, not just a manual validate.
 *
 * Design (2026-10-20): the plugin ships a SKILL.md skill + commands only. It
 * installs NO hooks — a plugin must never silently add a PreToolUse guard or a
 * Stop hook that blocks the user. Hooks remain available via the CLI for anyone
 * who opts in and wires them up themselves.
 */
const root = join(__dirname, "..");
const readJson = (p: string) => JSON.parse(readFileSync(join(root, p), "utf-8"));

describe("Claude Code plugin + marketplace manifest", () => {
  it("marketplace.json points at the ./plugin source and is named rulereceipt", () => {
    const m = readJson(".claude-plugin/marketplace.json");
    expect(m.name).toBe("rulereceipt");
    expect(m.owner?.name).toBeTruthy();
    expect(Array.isArray(m.plugins)).toBe(true);
    expect(m.plugins[0].name).toBe("rulereceipt");
    expect(m.plugins[0].source).toBe("./plugin");
  });

  it("plugin.json is valid: kebab-case name, version, no spaces", () => {
    const p = readJson("plugin/.claude-plugin/plugin.json");
    expect(p.name).toBe("rulereceipt");
    expect(p.name).toMatch(/^[a-z0-9-]+$/);
    expect(p.version).toBeTruthy();
  });

  it("installs NO hooks — the plugin never auto-wires a guard or Stop hook", () => {
    // The whole point of the skill+command design: no silent PreToolUse/Stop hook.
    expect(existsSync(join(root, "plugin/hooks/hooks.json"))).toBe(false);
    expect(existsSync(join(root, "plugin/hooks"))).toBe(false);
  });

  it("ships the rulereceipt skill in the shared SKILL.md format", () => {
    const p = join(root, "plugin/skills/rulereceipt/SKILL.md");
    expect(existsSync(p)).toBe(true);
    const body = readFileSync(p, "utf-8");
    // Open Agent Skills frontmatter (name == dir, description present).
    expect(body).toMatch(/^---[\s\S]*\nname:\s*rulereceipt\b/);
    expect(body).toMatch(/\ndescription:\s*\S/);
    // Runs the read-only check, never --llm, no server/upload.
    expect(body).toContain("npx rulereceipt check");
    expect(body).toMatch(/Never pass `--llm`/);
  });

  it("ships the four commands", () => {
    for (const c of ["check", "audit", "health", "why"]) {
      expect(existsSync(join(root, "plugin", "commands", `${c}.md`)), c).toBe(true);
    }
  });

  it("neither manifest claims a guard/Stop hook anymore", () => {
    const market = readFileSync(join(root, ".claude-plugin/marketplace.json"), "utf-8");
    const plugin = readFileSync(join(root, "plugin/.claude-plugin/plugin.json"), "utf-8");
    for (const raw of [market, plugin]) {
      expect(raw).not.toMatch(/Stop hook/i);
      expect(raw).not.toMatch(/PreToolUse/);
    }
  });
});
