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
const COMMANDS = ["check", "audit", "history", "protect", "card", "selftest", "rules", "init", "report", "doctor", "lint", "digest", "config", "demo", "verify", "team", "activate"];

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

/**
 * Cold-start smoke states — the first thing a stranger does after `npx`.
 *
 * The whole promise on the launch checklist is that a cold install never
 * embarrasses us: no rules file, an empty rules file, no session — none of
 * these may throw a stack trace, and each must tell the user the next
 * command to run. A crash on the very first command is the worst possible
 * first impression for a tool whose entire pitch is "trust me, I don't lie."
 *
 * HOME is redirected to an empty dir so the machine's real global
 * ~/.claude/CLAUDE.md can't leak in and make an "empty" project look
 * populated — the exact confusion that made a hand-run of these look fine
 * while proving nothing. A stack trace is detected structurally (a Node
 * "    at <frame>" line), not by matching any one message, so reworded copy
 * doesn't silently disable the guard.
 */
describe("cold-start smoke states never crash and always name the next step", () => {
  const home = mkdtempSync(join(tmpdir(), "rr-smoke-home-"));

  afterAll(() => rmSync(home, { recursive: true, force: true }));

  /** Runs the built CLI with an isolated HOME; returns output + exit code. */
  function cold(args: string[], cwd: string): { out: string; code: number } {
    try {
      const out = execFileSync("node", [CLI, ...args], {
        cwd,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, HOME: home, USERPROFILE: home },
      });
      return { out, code: 0 };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; status?: number };
      return { out: `${e.stdout ?? ""}${e.stderr ?? ""}`, code: e.status ?? -1 };
    }
  }

  const noStackTrace = (out: string) => expect(out).not.toMatch(/^\s+at\s+.+:\d+:\d+/m);

  it("audit in an empty project: exit 0, says where rules go, no stack trace", () => {
    const d = mkdtempSync(join(tmpdir(), "rr-smoke-empty-"));
    const { out, code } = cold(["audit"], d);
    rmSync(d, { recursive: true, force: true });
    expect(code).toBe(0);
    expect(out.toLowerCase()).toContain("no rules file found");
    expect(out).toMatch(/CLAUDE\.md|AGENTS\.md/);
    noStackTrace(out);
  });

  it("audit --json in an empty project: exit 0, valid zero JSON", () => {
    const d = mkdtempSync(join(tmpdir(), "rr-smoke-json-"));
    const { out, code } = cold(["audit", "--json"], d);
    rmSync(d, { recursive: true, force: true });
    expect(code).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.total).toBe(0);
    expect(parsed.checkable).toBe(0);
  });

  it("audit with an empty CLAUDE.md: exit 0, no stack trace", () => {
    const d = mkdtempSync(join(tmpdir(), "rr-smoke-emptyfile-"));
    writeFileSync(join(d, "CLAUDE.md"), "");
    const { out, code } = cold(["audit"], d);
    rmSync(d, { recursive: true, force: true });
    expect(code).toBe(0);
    expect(out.toLowerCase()).toMatch(/0 rules|no rules in it|none parsed/);
    noStackTrace(out);
  });

  it("check with no rules and no session: exit 0, names the next step", () => {
    const d = mkdtempSync(join(tmpdir(), "rr-smoke-nocheck-"));
    const { out, code } = cold(["check"], d);
    rmSync(d, { recursive: true, force: true });
    expect(code).toBe(0);
    expect(out.toLowerCase()).toMatch(/nothing to check|no claude\.md|add rules/);
    noStackTrace(out);
  });

  it("check with rules present but no session: exit 0, tells them to run a session first", () => {
    const d = mkdtempSync(join(tmpdir(), "rr-smoke-nosession-"));
    writeFileSync(join(d, "CLAUDE.md"), "## 1. Never push to `main`\n- Always run `npm test`\n");
    const { out, code } = cold(["check"], d);
    rmSync(d, { recursive: true, force: true });
    expect(code).toBe(0);
    expect(out.toLowerCase()).toContain("no coding-agent session");
    noStackTrace(out);
  });

  it("check --require-session with no session: exit 1 (documented), no stack trace", () => {
    const d = mkdtempSync(join(tmpdir(), "rr-smoke-require-"));
    writeFileSync(join(d, "CLAUDE.md"), "## 1. Never push to `main`\n");
    const { out, code } = cold(["check", "--require-session"], d);
    rmSync(d, { recursive: true, force: true });
    expect(code).toBe(1);
    noStackTrace(out);
  });

  it("demo needs no setup: exit 0, prints sample output, no stack trace", () => {
    const d = mkdtempSync(join(tmpdir(), "rr-smoke-demo-"));
    const { out, code } = cold(["demo"], d);
    rmSync(d, { recursive: true, force: true });
    expect(code).toBe(0);
    expect(out.toLowerCase()).toContain("sample output");
    noStackTrace(out);
  });
});

describe("help text", () => {
  it("wrong --help mentions --submit and --email", () => {
    const { out } = run(["wrong", "--help"]);
    expect(out).toContain("--submit");
    expect(out).toContain("--email");
  });
  it("report --help describes the team version, not a Compliance API", () => {
    const { out } = run(["report", "--help"]);
    expect(out.toLowerCase()).toContain("team version");
    expect(out).not.toContain("Compliance API");
  });
});

describe("summary names how many rules were not checked, and suggests --llm (dogfood #4)", () => {
  const home = mkdtempSync(join(tmpdir(), "rr-llm-home-"));
  afterAll(() => rmSync(home, { recursive: true, force: true }));
  it("a judgment-only rule reports it was NOT checked and points at --llm", () => {
    const d = mkdtempSync(join(tmpdir(), "rr-llm-"));
    writeFileSync(join(d, "CLAUDE.md"), "## 1. Clarity\nAlways write clean, elegant, maintainable code.\n");
    writeFileSync(join(d, "s.jsonl"), JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] } }));
    let out = "";
    try {
      out = execFileSync("node", [CLI, "check", "--transcript", "s.jsonl"], { cwd: d, encoding: "utf-8", env: { ...process.env, HOME: home, USERPROFILE: home } });
    } catch (e) {
      out = `${(e as { stdout?: string }).stdout ?? ""}`;
    }
    rmSync(d, { recursive: true, force: true });
    expect(out).toContain("need judgment and were NOT checked");
    expect(out).toContain("--llm");
  });
});
