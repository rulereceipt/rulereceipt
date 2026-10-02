import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardDecision } from "../src/guard.js";
import type { CheckResult } from "../src/types.js";

/**
 * Guard false alarm, dogfooded 2026-10-02: "never wipe the database without
 * asking" stopped a throwaway `rm -rf /tmp/scratch` in auto mode. A delete gate
 * must only engage on a real data store, never a scratch/build cleanup.
 */
let dir: string, home: string, prevHome: string | undefined, prevCfg: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rr-del-"));
  home = mkdtempSync(join(tmpdir(), "rr-del-home-"));
  prevHome = process.env.HOME; prevCfg = process.env.CLAUDE_CONFIG_DIR;
  process.env.HOME = home; process.env.USERPROFILE = home; delete process.env.CLAUDE_CONFIG_DIR;
  writeFileSync(join(dir, "CLAUDE.md"), "## 1. Data\nNever delete the `data/` database without asking me first.\n");
});
afterEach(() => {
  process.env.HOME = prevHome;
  if (prevCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prevCfg;
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});
const g = (command: string) => guardDecision(dir, "Bash", { command }, [], "bypassPermissions");

describe("delete gate is scoped to data stores (guard)", () => {
  it("does NOT stop a throwaway scratch cleanup", () => {
    expect(g("rm -rf /tmp/scratch-xyz").deny).toBe(false);
    expect(g("rm -rf build/ dist/").deny).toBe(false);
    expect(g("rm -rf node_modules").deny).toBe(false);
  });
  it("DOES gate a real data-store deletion in a no-prompt mode", () => {
    expect(g("rm -rf data/app.db").deny).toBe(true);
    expect(g("rm -rf ./database").deny).toBe(true);
  });
  // Known limit: SQL passed as a quoted arg (`psql -c 'DROP TABLE x'`) is
  // stripped as a quoted mention by the approval gate, so it is NOT gated. That
  // is the safe direction (an under-gate, never a false accusation); a bare
  // `drop table` in the command text still counts.
  it("gates a bare (unquoted) SQL drop in the command text", () => {
    expect(g("mysql mydb -e drop table users").deny).toBe(true);
  });
});
