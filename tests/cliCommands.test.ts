import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

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
