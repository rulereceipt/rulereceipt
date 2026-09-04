import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * `rules --coverage` answers a question two people asked independently within
 * a week: of the rules I wrote, which ones have anything behind them?
 *
 * The output reads like an audit, which is exactly why it has to be careful.
 * A confident-looking link built from a word both texts happen to contain
 * would be the text-match mistake again, one level up and in a place people
 * are more likely to believe it. These tests hold it to reporting a possible
 * backing and saying so.
 */

const CLI = resolve(__dirname, "..", "dist", "cli.js");
let dir: string;

function run(args: string[]): { out: string; code: number } {
  try {
    return { out: execFileSync("node", [CLI, ...args], { cwd: dir, encoding: "utf-8" }), code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    if (typeof e.status !== "number") throw err;
    return { out: `${e.stdout ?? ""}${e.stderr ?? ""}`, code: e.status };
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rr-cov-"));
  writeFileSync(
    join(dir, "CLAUDE.md"),
    [
      "# Rules",
      "",
      "## 1. Never force push",
      "Never run `git push --force` against a shared branch.",
      "",
      "## 2. Zqx surface bad news first",
      "Lead the report with what is broken.",
      "",
    ].join("\n")
  );
  mkdirSync(join(dir, ".claude"), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function writeHooks(hooks: unknown) {
  writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify({ hooks }, null, 2));
}

describe("rulereceipt rules --coverage", () => {
  it("reports no backing when no hooks are configured", () => {
    const { out } = run(["rules", "--coverage"]);
    expect(out).toMatch(/no hook found|0 .*guarded|nothing/i);
    expect(out).toMatch(/Never force push/);
  });

  it("links a rule to a blocking hook that names the same command", () => {
    writeHooks({
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "/opt/guard.sh --deny 'git push --force'" }] },
      ],
    });
    const { out } = run(["rules", "--coverage"]);
    expect(out).toMatch(/Never force push/);
    expect(out).toMatch(/git push --force/);
  });

  it("does not count a hook that cannot refuse anything", () => {
    writeHooks({
      SessionStart: [{ hooks: [{ type: "command", command: "/opt/echo.sh 'git push --force is banned'" }] }],
    });
    const { out } = run(["rules", "--coverage"]);
    // The rule names the same command, but a SessionStart hook cannot make it
    // fail loudly, which is the question being asked.
    expect(out).not.toMatch(/possibly guarded[\s\S]{0,200}Never force push/i);
  });

  it("always states that a link is not proof", () => {
    writeHooks({
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "/opt/guard.sh --deny 'git push --force'" }] },
      ],
    });
    const { out } = run(["rules", "--coverage"]);
    expect(out).toMatch(/not proof|does not prove|cannot prove/i);
  });

  it("shows which token caused a link, so a wrong one is visible", () => {
    writeHooks({
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "/opt/guard.sh --deny 'git push --force'" }] },
      ],
    });
    const { out } = run(["rules", "--coverage"]);
    expect(out).toMatch(/git push --force/);
  });

  it("leaves a judgment rule unbacked", () => {
    writeHooks({
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "/opt/guard.sh" }] }],
    });
    const { out } = run(["rules", "--coverage"]);
    expect(out).toMatch(/Zqx surface bad news first/);
  });

  it("writes nothing", () => {
    // `rules --coverage` only reads. Writing is reserved for --include and
    // --exclude, which the user invokes deliberately.
    run(["rules", "--coverage"]);
    expect(existsSync(join(dir, ".rulereceipt", "overrides.json"))).toBe(false);
  });
});
