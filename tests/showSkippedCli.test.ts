import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * End-to-end coverage of --show-skipped.
 *
 * The classifier decides which lines in a rules file are genuine rules and
 * which are documentation, and it is a heuristic over English verbs. It will
 * be wrong. Measured against a 559-file corpus it drops non-English content
 * at 97.5% against a 64.5% baseline, because a list of English verbs cannot
 * match a Chinese sentence under any circumstances — and any imperative verb
 * outside the list is invisible for the same reason.
 *
 * Neither gap is closable by extending the list; imperative verbs are not a
 * closed class and the list is English-only by construction. What IS closable
 * is the silence. A rule dropped without the user ever seeing it is the
 * failure this whole tool exists to prevent: the report reads clean, and the
 * rule was never checked.
 *
 * So the guarantee under test is not that classification is correct. It is
 * that a user can always find out what was excluded, in any language and any
 * phrasing, and judge it themselves — which needs no API key and has no
 * coverage gap.
 *
 * Runs the built CLI as a real subprocess: the thing under test is flag
 * wiring and printed output, not a function.
 */

const CLI = resolve(__dirname, "..", "dist", "cli.js");
let dir: string;

function run(args: string[]): string {
  try {
    return execFileSync("node", [CLI, ...args], { cwd: dir, encoding: "utf-8" });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    if (typeof e.status !== "number") throw err; // a real crash, not a rule failure
    return `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "rr-skipped-"));
  writeFileSync(
    join(dir, "CLAUDE.md"),
    [
      "# Rules",
      "",
      "## 1. Never commit directly to main",
      "Never commit directly to the `main` branch.",
      "",
      "## Reference",
      "- `--file=<path>`: Use alternative tasks.json file",
      "- 首先，你需要完整阅读所在代码文件库",
      "",
    ].join("\n")
  );
  writeFileSync(
    join(dir, "session.jsonl"),
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
    })
  );
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("rulereceipt check --show-skipped", () => {
  it("tells the user the flag exists, rather than only a count", () => {
    const out = run(["check", "--transcript", "session.jsonl"]);
    expect(out).toMatch(/--show-skipped/);
  });

  it("does not dump the skipped items unless asked", () => {
    const out = run(["check", "--transcript", "session.jsonl"]);
    expect(out).not.toContain("--file=<path>");
  });

  it("lists what was excluded when asked", () => {
    const out = run(["check", "--show-skipped", "--transcript", "session.jsonl"]);
    expect(out).toContain("--file=<path>");
  });

  it("shows a non-English rule that the English verb list cannot classify", () => {
    // The specific failure this flag exists for: a real instruction that the
    // classifier drops silently, which the person who wrote it can recognise
    // at a glance even though no heuristic here can.
    const out = run(["check", "--show-skipped", "--transcript", "session.jsonl"]);
    expect(out).toContain("首先");
  });

  it("still checks the rules it did recognise", () => {
    const out = run(["check", "--show-skipped", "--transcript", "session.jsonl"]);
    expect(out).toMatch(/Never commit directly to main/);
  });
});
