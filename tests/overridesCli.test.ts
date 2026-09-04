import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

/**
 * End-to-end coverage of the correction loop.
 *
 * `--show-skipped` makes a misclassification visible; overrides make the fix
 * permanent. Neither half is useful alone: seeing the mistake every run and
 * being unable to act on it is only marginally better than not seeing it.
 *
 * The fixture rule is shaped like the real one this feature exists for. This
 * project's own "No silent scope changes" was filed as documentation and never
 * checked in any report the tool produced, because it says "say so explicitly"
 * and `say` is not on the classifier's English word list. The title here is
 * deliberately nonsense so it cannot collide with a rule in the developer's
 * actual global CLAUDE.md — an earlier version did collide, and the stale
 * test passed for the wrong reason because the global copy outlived the
 * project one.
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
  dir = mkdtempSync(join(tmpdir(), "rr-ovrcli-"));
  writeFileSync(
    join(dir, "CLAUDE.md"),
    [
      "# Rules",
      "",
      "## 1. Never commit directly to main",
      "Never commit directly to the `main` branch.",
      "",
      "## 2. Zqx unique project rule for tests",
      "If you skip a requested step, say so explicitly at the top of the report.",
      "",
    ].join("\n")
  );
  writeFileSync(
    join(dir, "s.jsonl"),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } })
  );
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("rulereceipt rules", () => {
  it("--show-skipped prints a stable handle for each excluded item", () => {
    const { out } = run(["check", "--show-skipped", "--transcript", "s.jsonl"]);
    expect(out).toMatch(/Zqx unique project rule for tests/);
    // A handle the user can pass back in. Without one there is no way to
    // name the item they want corrected.
    expect(out).toMatch(/\[[0-9a-f]{12}\]/);
  });

  it("the handle is stable across runs", () => {
    const a = run(["check", "--show-skipped", "--transcript", "s.jsonl"]).out;
    const b = run(["check", "--show-skipped", "--transcript", "s.jsonl"]).out;
    const hashOf = (s: string) => (s.match(/\[([0-9a-f]{12})\]/) ?? [])[1];
    expect(hashOf(a)).toBeDefined();
    expect(hashOf(a)).toBe(hashOf(b));
  });

  it("including a skipped item makes it appear in the report", () => {
    const skipped = run(["check", "--show-skipped", "--transcript", "s.jsonl"]).out;
    const hash = (skipped.match(/\[([0-9a-f]{12})\] Zqx unique project rule for tests/) ?? [])[1];
    expect(hash).toBeDefined();

    const set = run(["rules", "--include", hash!]);
    expect(set.code).toBe(0);

    const after = run(["check", "--transcript", "s.jsonl"]).out;
    expect(after).toMatch(/Zqx unique project rule for tests/);
  });

  it("the correction survives, rather than needing to be repeated", () => {
    const skipped = run(["check", "--show-skipped", "--transcript", "s.jsonl"]).out;
    const hash = (skipped.match(/\[([0-9a-f]{12})\] Zqx unique project rule for tests/) ?? [])[1];
    run(["rules", "--include", hash!]);
    for (let i = 0; i < 3; i++) {
      expect(run(["check", "--transcript", "s.jsonl"]).out).toMatch(/Zqx unique project rule for tests/);
    }
  });

  it("excluding a rule removes it from the report", () => {
    // Previously this asserted inside an `if`, so it passed whether or not
    // exclusion worked. Compute the handle directly instead.
    expect(run(["check", "--transcript", "s.jsonl"]).out).toMatch(/Never commit directly to main/);
    const hash = createHash("sha256")
      .update("Never commit directly to main\nNever commit directly to the `main` branch.".replace(/\s+/g, " ").trim())
      .digest("hex")
      .slice(0, 12);
    const set = run(["rules", "--exclude", hash]);
    expect(set.code).toBe(0);
    expect(run(["check", "--transcript", "s.jsonl"]).out).not.toMatch(/Never commit directly to main/);
  });

  it("check never writes an overrides file on its own", () => {
    run(["check", "--show-skipped", "--transcript", "s.jsonl"]);
    expect(existsSync(join(dir, ".rulereceipt", "overrides.json"))).toBe(false);
  });

  it("warns when a stored correction no longer matches any rule", () => {
    const skipped = run(["check", "--show-skipped", "--transcript", "s.jsonl"]).out;
    const hash = (skipped.match(/\[([0-9a-f]{12})\] Zqx unique project rule for tests/) ?? [])[1];
    run(["rules", "--include", hash!]);
    // Reword the rule: the correction no longer applies and the user must be
    // told, rather than assuming it still holds.
    writeFileSync(
      join(dir, "CLAUDE.md"),
      "# Rules\n\n## 1. Never commit directly to main\nNever commit to `main`.\n"
    );
    const out = run(["check", "--transcript", "s.jsonl"]).out;
    expect(out).toMatch(/no longer match|stale|no longer applies/i);
  });
});
