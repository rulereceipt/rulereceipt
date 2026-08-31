import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Every subcommand must actually be reachable.
 *
 * Written while reviewing the commander 12 -> 15 bump (2026-08-31), which
 * exposed a genuine coverage hole: the suite invoked `check` and nothing
 * else, so a routing change that made `doctor`, `lint`, `digest`,
 * `config`, `demo` or `verify` unreachable would have shipped with a
 * fully green run. `check` is registered with `isDefault: true`, which is
 * exactly the configuration where a parser change can silently reroute
 * every other command into it.
 *
 * (The bump itself turned out to be safe. The first read of it was wrong:
 * a zsh loop passed "doctor --help" as ONE argument, since zsh does not
 * word-split unquoted expansions the way bash does, and commander
 * correctly rejected that single unknown argument. Worth recording — the
 * scare was a test-harness bug, not a dependency bug, and the coverage
 * gap it revealed was real either way.)
 *
 * These run the built binary as a real subprocess, because the thing being
 * tested is argument routing — importing the module would skip exactly the
 * layer at risk.
 */

const CLI = resolve(__dirname, "..", "dist", "cli.js");

function run(args: string[]): { out: string; ok: boolean } {
  try {
    return { out: execFileSync("node", [CLI, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }), ok: true };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { out: `${e.stdout ?? ""}${e.stderr ?? ""}`, ok: false };
  }
}

// Every command registered in cli.ts. Adding a command here is the point:
// a new subcommand that isn't routable should fail this suite.
const COMMANDS = ["check", "doctor", "lint", "digest", "config", "demo", "verify"];

describe("every subcommand is reachable, not swallowed by the default command", () => {
  for (const cmd of COMMANDS) {
    it(`\`${cmd} --help\` resolves to ${cmd}, not to the default command`, () => {
      const { out } = run([cmd, "--help"]);
      expect(out).toContain(`rulereceipt ${cmd}`);
      // The exact symptom of the commander 15 break.
      expect(out).not.toContain("too many arguments");
    });
  }

  it("bare --help lists every command", () => {
    const { out } = run(["--help"]);
    for (const cmd of COMMANDS) expect(out).toContain(cmd);
  });

  it("--version prints a version, not a parse error", () => {
    const { out } = run(["--version"]);
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  // check is the default command, so a bare invocation must still route to
  // it — the property that makes `npx rulereceipt` work with no arguments.
  it("check is still the default command when no subcommand is given", () => {
    const { out } = run(["--transcript", "definitely-not-a-real-file.jsonl"]);
    expect(out).not.toContain("unknown command");
    expect(out).not.toContain("too many arguments");
  });

  // commander 12 silently swallowed an unknown positional argument into
  // the default command, so `rulereceipt doctro` (typo) quietly ran a
  // normal check instead of telling the user their command didn't exist.
  // commander 15 errors instead. Locking that in: for a tool people run
  // to get an answer, a typo must fail loudly rather than return a
  // plausible-looking report for something they didn't ask for.
  it("an unknown subcommand is rejected, not silently treated as an argument", () => {
    const { out, ok } = run(["definitelynotacommand"]);
    expect(ok).toBe(false);
    expect(out.toLowerCase()).toMatch(/unknown|error|too many arguments/);
  });
});

/**
 * Exit codes. CI can only gate on this, so it is the difference between a
 * check that protects a repository and one that decorates it.
 *
 * Real shipped falsehood found 2026-08-31: templates/rulereceipt-ci.yml
 * told people to copy a workflow and stated "rulereceipt already exits
 * non-zero on FAIL, this just wires that into CI" — while `check` always
 * exited 0. Anyone following that template had a green build while the
 * agent broke their rules, which is worse than no check at all, because a
 * passing job reads as evidence that nothing went wrong.
 */
describe("exit codes", () => {
  const dir = mkdtempSync(join(tmpdir(), "rr-exit-"));

  beforeAll(() => {
    writeFileSync(
      join(dir, "CLAUDE.md"),
      "# Rules\n\n## 1. No console.log\nNever leave a `console.log(` call in committed code.\n"
    );
    writeFileSync(
      join(dir, "fail.jsonl"),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "tool_use", name: "Write", input: { file_path: "a.ts", content: "console.log(1)" } }] },
      })
    );
    writeFileSync(
      join(dir, "pass.jsonl"),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] },
      })
    );
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function exitCodeFor(args: string[]): number {
    try {
      execFileSync("node", [CLI, ...args], { cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
      return 0;
    } catch (err) {
      return (err as { status?: number }).status ?? -1;
    }
  }

  it("exits 1 when a rule was actually broken, so CI can gate on it", () => {
    expect(exitCodeFor(["check", "--transcript", "fail.jsonl"])).toBe(1);
  });

  it("exits 0 when nothing was broken", () => {
    expect(exitCodeFor(["check", "--transcript", "pass.jsonl"])).toBe(0);
  });

  it("--exit-zero reports the failure but does not fail the build", () => {
    expect(exitCodeFor(["check", "--transcript", "fail.jsonl", "--exit-zero"])).toBe(0);
  });

  // Not a softening. Most rules in a real CLAUDE.md need judgment and
  // legitimately report UNCLEAR without --llm; gating on those would make
  // every build red on day one and the check would be deleted in a week.
  it("does NOT fail the build for rules that merely need human review", () => {
    const u = mkdtempSync(join(tmpdir(), "rr-exit-unclear-"));
    writeFileSync(join(u, "CLAUDE.md"), "# Rules\n\n## 1. Surface bad news first\nAlways lead a status report with what is broken.\n");
    writeFileSync(join(u, "s.jsonl"), JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] },
    }));
    try {
      execFileSync("node", [CLI, "check", "--transcript", "s.jsonl"], { cwd: u, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      throw new Error("UNCLEAR results must not fail the build");
    } finally {
      rmSync(u, { recursive: true, force: true });
    }
  });
});
