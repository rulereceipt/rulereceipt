import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * End-to-end coverage of the --html wiring itself.
 *
 * generateHtmlReport.test.ts proves the document is correct given results.
 * This proves the CLI actually reaches it: that the flag is parsed, that a
 * file lands where the user was told it would, and — the part unit tests
 * cannot show — that the flag is genuinely opt-in, so nobody gets an
 * unexpected file written into their working directory.
 *
 * Runs the built CLI as a real subprocess rather than importing it, since
 * the thing under test is argument parsing and file output, not a function.
 */

const CLI = resolve(__dirname, "..", "dist", "cli.js");

let dir: string;

/**
 * Captures output regardless of exit code. These fixtures deliberately
 * break a rule, and `check` exits 1 when a rule was actually broken (so
 * CI can gate on it), which makes execFileSync throw. That non-zero exit
 * is correct behaviour, not a test failure — this suite is asserting on
 * file output, and exit codes have their own tests in cliCommands.test.ts.
 */
function run(args: string[]): string {
  try {
    return execFileSync("node", [CLI, ...args], {
      cwd: dir,
      encoding: "utf-8",
      // The tool also reads global ~/.claude*/CLAUDE.md; that's real behaviour
      // and harmless here — these assertions are about file output only.
    });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    if (typeof e.status !== "number") throw err; // a real crash, not a rule failure
    return `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "rr-html-cli-"));
  writeFileSync(
    join(dir, "CLAUDE.md"),
    "# Rules\n\n## 1. Never commit directly to main\nNever commit directly to the `main` branch.\n"
  );
  writeFileSync(
    join(dir, "session.jsonl"),
    [
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "git checkout main" } }] },
      }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "git commit -am wip" } }] },
      }),
    ].join("\n")
  );
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("rulereceipt check --html", () => {
  // The guarantee that matters most: no surprise files. A tool that writes
  // into someone's working directory without being asked is a tool people
  // stop trusting.
  it("writes NOTHING when --html is not passed", () => {
    run(["check", "--transcript", "session.jsonl"]);
    expect(existsSync(join(dir, "rulereceipt-report.html"))).toBe(false);
  });

  it("writes the default file when --html is passed bare", () => {
    const out = run(["check", "--transcript", "session.jsonl", "--html"]);
    const written = join(dir, "rulereceipt-report.html");
    expect(existsSync(written)).toBe(true);
    expect(out).toContain("Shareable report written to");
    rmSync(written, { force: true });
  });

  it("honours an explicit path", () => {
    const target = join(dir, "custom-name.html");
    run(["check", "--transcript", "session.jsonl", "--html", "custom-name.html"]);
    expect(existsSync(target)).toBe(true);
    rmSync(target, { force: true });
  });

  it("produces a report that actually contains the real violation it found", () => {
    const target = join(dir, "evidence.html");
    run(["check", "--transcript", "session.jsonl", "--html", "evidence.html"]);
    const html = readFileSync(target, "utf-8");
    expect(html).toContain("Never commit directly to main");
    expect(html).toContain("git commit -am wip");
    expect(html).toContain("verdict--fail");
    rmSync(target, { force: true });
  });

  it("still prints the terminal report when --html is used", () => {
    const out = run(["check", "--transcript", "session.jsonl", "--html", "both.html"]);
    expect(out).toContain("RuleReceipt");
    expect(out).toContain("fail");
    rmSync(join(dir, "both.html"), { force: true });
  });
});
