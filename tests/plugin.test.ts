import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * The self-hosted Claude Code plugin + marketplace. `claude plugin validate` is
 * the authoritative check (run in CI/release); this pins the fields RuleReceipt
 * relies on so a regression (wrong source path, a hook that stops invoking the
 * guard, a missing command) fails the suite, not just a manual validate.
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

  it("the guard + Stop hooks invoke the rulereceipt CLI (no matcher = all tools)", () => {
    const h = readJson("plugin/hooks/hooks.json").hooks;
    const cmd = (event: string) => h[event][0].hooks[0].command as string;
    expect(cmd("PreToolUse")).toMatch(/rulereceipt guard/);
    expect(cmd("Stop")).toMatch(/rulereceipt hook/);
    // No matcher field -> fires on every tool (so no dead tool names to maintain).
    expect(h.PreToolUse[0].matcher).toBeUndefined();
  });

  it("hooks FAIL OPEN when rulereceipt isn't installed — never a silent auto-download", () => {
    const h = readJson("plugin/hooks/hooks.json").hooks;
    for (const event of ["PreToolUse", "Stop"]) {
      const cmd = h[event][0].hooks[0].command as string;
      // Must NOT auto-install/download (npx --yes / -y fetches from the network).
      expect(cmd, event).not.toMatch(/npx\s+(--yes|-y)\b/);
      expect(cmd, event).not.toMatch(/\bnpx\b/); // no npx at all -> no accidental fetch
      // Must gate on the CLI being present and fail open with an install hint.
      expect(cmd, event).toMatch(/command -v rulereceipt/);
      expect(cmd, event).toMatch(/npm i -g rulereceipt/);
      expect(cmd, event).toMatch(/exit 0/);
    }
  });

  it("ships the four commands", () => {
    for (const c of ["check", "audit", "health", "why"]) {
      expect(existsSync(join(root, "plugin", "commands", `${c}.md`)), c).toBe(true);
    }
  });

  it("hooks reference no network URL (the guard and checks run locally)", () => {
    const raw = readFileSync(join(root, "plugin/hooks/hooks.json"), "utf-8");
    expect(raw).not.toMatch(/https?:\/\//);
  });
});
