import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { describeRuleSources } from "../src/rules.js";

/**
 * Which rules file Claude Code actually LOADS, per its 2.1.277 precedence
 * (default "Project instructions" = claude-md-or-agents-md): AGENTS.md is read
 * only when the level has no CLAUDE.md AND no CLAUDE.local.md. Checking a
 * shadowed file would be a false accusation, so the load graph must mark it
 * shadowed. HOME is isolated so the machine's own ~/.claude can't leak in.
 */
let dir: string, home: string, prevHome: string | undefined, prevCfg: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rr-prec-"));
  home = mkdtempSync(join(tmpdir(), "rr-prec-home-"));
  prevHome = process.env.HOME; prevCfg = process.env.CLAUDE_CONFIG_DIR;
  process.env.HOME = home; process.env.USERPROFILE = home; delete process.env.CLAUDE_CONFIG_DIR;
});
afterEach(() => {
  process.env.HOME = prevHome;
  if (prevCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prevCfg;
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});
const w = (name: string, body = "- a rule\n") => writeFileSync(join(dir, name), body);
/** status of a file by basename in the load graph, or "absent". */
const statusOf = (name: string) => {
  const e = describeRuleSources(dir).find((g) => basename(g.path) === name);
  return e ? e.status : "absent";
};

describe("rules-file precedence (2.1.277) — check what was actually loaded", () => {
  it("CLAUDE.md + AGENTS.md: CLAUDE.md loaded, AGENTS.md shadowed", () => {
    w("CLAUDE.md"); w("AGENTS.md");
    expect(statusOf("CLAUDE.md")).toBe("loaded");
    expect(statusOf("AGENTS.md")).toBe("shadowed");
  });

  it("AGENTS.md alone: loaded", () => {
    w("AGENTS.md");
    expect(statusOf("AGENTS.md")).toBe("loaded");
  });

  it("CLAUDE.local.md + AGENTS.md (no CLAUDE.md): CLAUDE.local.md loaded, AGENTS.md SHADOWED", () => {
    w("CLAUDE.local.md"); w("AGENTS.md");
    expect(statusOf("CLAUDE.local.md")).toBe("loaded");
    expect(statusOf("AGENTS.md")).toBe("shadowed");
  });

  it("CLAUDE.md + CLAUDE.local.md + AGENTS.md: both Claude files loaded, AGENTS.md shadowed", () => {
    w("CLAUDE.md"); w("CLAUDE.local.md"); w("AGENTS.md");
    expect(statusOf("CLAUDE.md")).toBe("loaded");
    expect(statusOf("CLAUDE.local.md")).toBe("loaded");
    expect(statusOf("AGENTS.md")).toBe("shadowed");
  });
});
