import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { hookWiringFindings } from "../src/hookWiring.js";

/**
 * Hook-wiring check: compare PreToolUse matchers in settings against the tools
 * recent sessions actually used. Needs a real session transcript on disk under
 * the Claude Code project dir for this cwd, so each test writes one. Facts only.
 */
let dir: string;
let emptyHome: string;
let projectDir: string;

function writeSettings(matchers: (string | null)[]) {
  mkdirSync(join(dir, ".claude"), { recursive: true });
  const PreToolUse = matchers.map((m) => ({
    ...(m === null ? {} : { matcher: m }),
    hooks: [{ type: "command", command: "rulereceipt guard" }],
  }));
  writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse } }));
}

function writeSession(toolNames: string[]) {
  // Claude Code stores sessions under ~/.claude/projects/<cwd-with-slashes-as-dashes>/<uuid>.jsonl
  const slug = dir.replace(/[/.]/g, "-");
  projectDir = join(homedir(), ".claude", "projects", slug);
  mkdirSync(projectDir, { recursive: true });
  const lines = toolNames.map((name, i) =>
    JSON.stringify({
      type: "assistant",
      timestamp: `2026-10-04T00:00:0${i}Z`,
      message: { role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name, input: {} }] },
    })
  );
  writeFileSync(join(projectDir, "rr-hookwiring-test.jsonl"), lines.join("\n") + "\n");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rr-hw-"));
  emptyHome = mkdtempSync(join(tmpdir(), "rr-hw-home-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(emptyHome, { recursive: true, force: true });
  if (projectDir) rmSync(projectDir, { recursive: true, force: true });
});

describe("hook-wiring check", () => {
  it("flags a dead matcher — names a tool no recent session used", () => {
    writeSettings(["Write|Edit|MultiEditt"]); // typo'd tool name
    writeSession(["Write", "Edit", "Bash"]);
    const f = hookWiringFindings(dir, emptyHome);
    const dead = f.filter((x) => x.kind === "dead-matcher");
    expect(dead.length).toBe(1);
    expect(dead[0].message).toContain("MultiEditt");
  });

  it("flags an unguarded write tool — used, but no matcher covers it", () => {
    writeSettings(["Write|Edit"]); // does not cover Bash
    writeSession(["Write", "Bash", "Bash"]);
    const f = hookWiringFindings(dir, emptyHome);
    const unguarded = f.filter((x) => x.kind === "unguarded-tool");
    expect(unguarded.length).toBe(1);
    expect(unguarded[0].message).toContain("Bash");
    expect(unguarded[0].message).toContain("2 times");
  });

  it("stays silent when a matcher-less hook covers everything", () => {
    writeSettings([null]); // no matcher = guards all tools
    writeSession(["Write", "Bash", "NotebookEdit"]);
    expect(hookWiringFindings(dir, emptyHome)).toEqual([]);
  });

  it("does not call a wildcard/regex matcher dead", () => {
    writeSettings([".*"]);
    writeSession(["Write"]);
    expect(hookWiringFindings(dir, emptyHome).filter((x) => x.kind === "dead-matcher")).toEqual([]);
  });

  it("stays silent with no PreToolUse hooks at all", () => {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify({ hooks: {} }));
    writeSession(["Write", "Bash"]);
    expect(hookWiringFindings(dir, emptyHome)).toEqual([]);
  });
});
