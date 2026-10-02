import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardDecision, guardReceiptLine } from "../src/guard.js";

/** Live-blocking shadow mode (vs Failproof): a block is recorded, enforce vs shadow. */
let dir: string, home: string, prevHome: string | undefined, prevCfg: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rr-shadow-"));
  home = mkdtempSync(join(tmpdir(), "rr-shadow-home-"));
  prevHome = process.env.HOME; prevCfg = process.env.CLAUDE_CONFIG_DIR;
  process.env.HOME = home; process.env.USERPROFILE = home; delete process.env.CLAUDE_CONFIG_DIR;
  writeFileSync(join(dir, "CLAUDE.md"), "## 1. Branch\nNever push to the `main` branch directly.\n");
});
afterEach(() => {
  process.env.HOME = prevHome;
  if (prevCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prevCfg;
  rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
});

describe("guardReceiptLine", () => {
  it("records the rule(s) and the mode-aware action", () => {
    const d = guardDecision(dir, "Bash", { command: "git push origin main" }, [], "bypassPermissions");
    expect(d.deny).toBe(true);
    const enforce = guardReceiptLine(d, "git push origin main", false);
    expect(enforce).toMatchObject({ mode: "enforce", action: "deny" });
    expect(enforce.rules.some((r) => /branch/i.test(r.title))).toBe(true);
    expect(enforce.command).toBe("git push origin main");
    const shadow = guardReceiptLine(d, "git push origin main", true);
    expect(shadow).toMatchObject({ mode: "shadow", action: "would-deny" });
  });
});
