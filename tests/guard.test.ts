import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * `rulereceipt guard` is the PreToolUse hook: it runs before EVERY tool call
 * in any session that installs it, and it is the one component that can harm a
 * user by wrongly refusing their command. Its building blocks (fileLifecycle,
 * gitBranchPolicy, ratified literals) are tested elsewhere; this file holds the
 * guard's own contract — the four properties in guard.ts that a regression
 * would break silently:
 *
 *   1. it denies a rule-breaking call with a nested `deny` decision + exit 2,
 *   2. it allows everything else, writing `{}` and exit 0,
 *   3. it FAILS OPEN — any internal error allows the command, never exit 2,
 *   4. an unmarked / rules-free project cannot produce a block.
 *
 * HOME is redirected to an empty dir in every run: loadRules() also reads the
 * global ~/.claude/CLAUDE.md, so without this the result would depend on the
 * developer's personal rules and the test would not be reproducible.
 */

const CLI = resolve(__dirname, "..", "dist", "cli.js");

let home: string;
let project: string;

function guard(payload: unknown, cwd = project): { out: string; code: number } {
  const input = typeof payload === "string" ? payload : JSON.stringify(payload);
  try {
    const out = execFileSync("node", [CLI, "guard"], {
      cwd,
      input,
      encoding: "utf-8",
      env: { ...process.env, HOME: home },
    });
    return { out, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    if (typeof e.status !== "number") throw err;
    return { out: `${e.stdout ?? ""}${e.stderr ?? ""}`, code: e.status };
  }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "rr-guard-home-"));
  project = mkdtempSync(join(tmpdir(), "rr-guard-proj-"));
  writeFileSync(
    join(project, "CLAUDE.md"),
    [
      "# Rules",
      "",
      "## 1. Never delete the ledger",
      "Never delete, remove, or wipe `data/ledger.db`. Do not run `rm` on",
      "`data/ledger.db` under any circumstances.",
      "",
    ].join("\n")
  );
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

describe("guard — deny path", () => {
  it("blocks a command that breaks a file rule, with exit 2", () => {
    const r = guard({ tool_name: "Bash", tool_input: { command: "rm data/ledger.db" } });
    expect(r.code).toBe(2);
    expect(r.out).toContain('"permissionDecision":"deny"');
    expect(r.out).toContain("Never delete the ledger");
  });

  it("emits the deny as a nested hookSpecificOutput block", () => {
    const r = guard({ tool_name: "Bash", tool_input: { command: "rm data/ledger.db" } });
    expect(r.out).toContain('"hookEventName":"PreToolUse"');
    // the reason is duplicated to stderr on the exit-2 path, deliberately
    expect(r.out).toContain("RuleReceipt blocked this");
  });
});

describe("guard — attribution prevention", () => {
  function attributionProject(): string {
    const dir = mkdtempSync(join(tmpdir(), "rr-guard-attrib-"));
    writeFileSync(
      join(dir, "CLAUDE.md"),
      [
        "# Rules",
        "",
        "## No AI attribution in git",
        "Never add `Co-Authored-By: Claude` to a commit, and never include",
        "\"Generated with Claude Code\" in a PR. Commits are authored by the team.",
        "",
      ].join("\n")
    );
    return dir;
  }

  it("blocks a commit carrying a Co-Authored-By trailer before it is made", () => {
    const dir = attributionProject();
    try {
      const r = guard(
        { tool_name: "Bash", tool_input: { command: 'git commit -m "x" -m "Co-Authored-By: Claude <noreply@anthropic.com>"' } },
        dir
      );
      expect(r.code).toBe(2);
      expect(r.out).toContain('"permissionDecision":"deny"');
      expect(r.out).toContain("No AI attribution in git");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows a clean commit with no trailer", () => {
    const dir = attributionProject();
    try {
      const r = guard({ tool_name: "Bash", tool_input: { command: 'git commit -m "fix the parser"' } }, dir);
      expect(r.code).toBe(0);
      expect(r.out.trim()).toBe("{}");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("guard — allow path", () => {
  it("allows a command that touches an unrelated file", () => {
    const r = guard({ tool_name: "Bash", tool_input: { command: "rm data/other.txt" } });
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("{}");
  });

  it("allows a benign command", () => {
    const r = guard({ tool_name: "Bash", tool_input: { command: "git status" } });
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("{}");
  });

  it("allows a tool the guard does not inspect (Read)", () => {
    const r = guard({ tool_name: "Read", tool_input: { file_path: "data/ledger.db" } });
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("{}");
  });
});

describe("guard — fails open", () => {
  it("allows (never exit 2) when stdin is not valid JSON", () => {
    const r = guard("this is not json {");
    expect(r.code).toBe(0);
    expect(r.out).toContain("{}");
  });

  it("allows when there are no rules to check against", () => {
    const empty = mkdtempSync(join(tmpdir(), "rr-guard-norules-"));
    try {
      const r = guard({ tool_name: "Bash", tool_input: { command: "rm data/ledger.db" } }, empty);
      expect(r.code).toBe(0);
      expect(r.out.trim()).toBe("{}");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
