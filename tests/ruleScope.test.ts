import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// Clean, empty HOME so real ~/.claude / ~/.codex global rules never leak in.
const homeState = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => homeState.current || actual.homedir() };
});

const { loadRules } = await import("../src/rules.js");

let proj = "";
let home = "";
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "rr-home-"));
  homeState.current = home;
  proj = mkdtempSync(join(tmpdir(), "rr-proj-"));
  mkdirSync(join(proj, ".git"));
});
afterEach(() => {
  rmSync(proj, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  homeState.current = "";
});

describe("tool-scoped rule loading (#4) — Codex reads only the AGENTS chain", () => {
  it("a Codex session gets AGENTS.md, never CLAUDE.md or ~/.claude", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "CLAUDE.md"), "- Global Claude rule.\n");
    writeFileSync(join(proj, "CLAUDE.md"), "- Never delete prod.\n");
    writeFileSync(join(proj, "AGENTS.md"), "- Never push to main without asking.\n");

    const codex = loadRules(proj, "codex").map((r) => r.title);
    expect(codex).toContain("Never push to main without asking.");
    expect(codex).not.toContain("Never delete prod."); // CLAUDE.md not read by Codex
    expect(codex).not.toContain("Global Claude rule."); // ~/.claude not read by Codex

    const claude = loadRules(proj, "claude-code").map((r) => r.title);
    expect(claude).toContain("Never delete prod.");
    expect(claude).toContain("Global Claude rule.");
  });

  it("reads ~/.codex/AGENTS.md as the Codex global", () => {
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "AGENTS.md"), "- Global Codex rule.\n");
    writeFileSync(join(proj, "AGENTS.md"), "- Local rule.\n");
    const titles = loadRules(proj, "codex").map((r) => r.title);
    expect(titles).toContain("Global Codex rule.");
    expect(titles).toContain("Local rule.");
  });
});

describe("identical rule text across files (#5) — counted once, both files named", () => {
  it("dedupes the same rule in CLAUDE.md and AGENTS.md, recording alsoSources", () => {
    // /config = load both, so AGENTS.md is not shadowed by CLAUDE.md.
    mkdirSync(join(proj, ".claude"), { recursive: true });
    writeFileSync(join(proj, ".claude", "settings.json"), JSON.stringify({ projectInstructions: "claude-md-and-agents-md" }));
    writeFileSync(join(proj, "CLAUDE.md"), "- Never push to main without asking.\n");
    writeFileSync(join(proj, "AGENTS.md"), "- Never push to main without asking.\n");

    const rules = loadRules(proj, "claude-code").filter((r) => r.title === "Never push to main without asking.");
    expect(rules).toHaveLength(1); // counted ONCE
    expect(rules[0].alsoSources?.length).toBe(1); // the other file is remembered
    const files = [rules[0].sourcePath, rules[0].alsoSources?.[0]?.sourcePath].map((p) => (p ?? "").split("/").pop());
    expect(files.sort()).toEqual(["AGENTS.md", "CLAUDE.md"]);
  });

  it("keeps genuinely different rules separate", () => {
    mkdirSync(join(proj, ".claude"), { recursive: true });
    writeFileSync(join(proj, ".claude", "settings.json"), JSON.stringify({ projectInstructions: "claude-md-and-agents-md" }));
    writeFileSync(join(proj, "CLAUDE.md"), "- Never push to main.\n");
    writeFileSync(join(proj, "AGENTS.md"), "- Never edit .env.\n");
    const titles = loadRules(proj, "claude-code").map((r) => r.title);
    expect(titles).toContain("Never push to main.");
    expect(titles).toContain("Never edit .env.");
  });
});
