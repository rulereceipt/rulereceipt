import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { planProtect, applyProtect, undoProtect } from "../src/protect.js";

const repo = () => mkdtempSync(join(tmpdir(), "rr-protect-"));
const settings = (dir: string) => join(dir, ".claude", "settings.json");
const backup = (dir: string) => join(dir, ".rulereceipt", "protect-backup.json");

describe("protect (plan / apply / undo)", () => {
  it("plans both hooks on a repo with no settings file", () => {
    const plan = planProtect(repo());
    expect(plan.existed).toBe(false);
    expect(plan.toAdd).toHaveLength(2);
    expect(plan.next).toContain("PreToolUse");
    expect(plan.next).toContain("rulereceipt guard");
    expect(plan.next).toContain("Stop");
    expect(plan.next).toContain("rulereceipt hook");
  });

  it("apply then undo removes a settings file that did not exist before", () => {
    const dir = repo();
    applyProtect(dir, planProtect(dir));
    expect(existsSync(settings(dir))).toBe(true);
    expect(existsSync(backup(dir))).toBe(true);
    const u = undoProtect(dir);
    expect(u.ok).toBe(true);
    expect(existsSync(settings(dir))).toBe(false); // there was no file before, so undo removes it
    expect(existsSync(backup(dir))).toBe(false);
  });

  it("preserves existing settings, and undo restores the EXACT original bytes", () => {
    const dir = repo();
    mkdirSync(join(dir, ".claude"));
    const original = '{\n  "permissions": {\n    "allow": [ "Bash(ls:*)" ]\n  }\n}\n';
    writeFileSync(settings(dir), original);
    applyProtect(dir, planProtect(dir));
    const after = readFileSync(settings(dir), "utf-8");
    expect(after).toContain("rulereceipt guard");
    expect(after).toContain("Bash(ls:*)"); // the user's own setting is preserved
    undoProtect(dir);
    expect(readFileSync(settings(dir), "utf-8")).toBe(original); // byte-for-byte
  });

  it("is idempotent: planning again after protecting has nothing to add", () => {
    const dir = repo();
    applyProtect(dir, planProtect(dir));
    expect(planProtect(dir).alreadyProtected).toBe(true);
  });

  it("undo with no backup is a clear no-op, not a crash", () => {
    const u = undoProtect(repo());
    expect(u.ok).toBe(false);
    expect(u.message.toLowerCase()).toContain("nothing to undo");
  });
});

describe("protect (CLI)", () => {
  const CLI = resolve(__dirname, "..", "dist", "cli.js");
  const run = (dir: string, ...args: string[]) =>
    execFileSync("node", [CLI, "protect", ...args], { cwd: dir, encoding: "utf-8", env: { ...process.env, HOME: mkdtempSync(join(tmpdir(), "rr-ph-")) } });

  it("--yes installs and points at undo; --undo restores", () => {
    const dir = repo();
    const out = run(dir, "--yes");
    expect(out).toContain("PreToolUse guard");
    expect(out).toContain("Stop hook");
    expect(out).toMatch(/Done — added to/);
    expect(readFileSync(settings(dir), "utf-8")).toContain("rulereceipt guard");
    const undo = run(dir, "--undo");
    expect(undo).toMatch(/Restored/);
    expect(existsSync(settings(dir))).toBe(false);
  });

  it("running --yes twice is idempotent (no duplicate hooks)", () => {
    const dir = repo();
    run(dir, "--yes");
    const out = run(dir, "--yes");
    expect(out).toContain("Already protected");
    const s = readFileSync(settings(dir), "utf-8");
    expect(s.match(/rulereceipt guard/g)).toHaveLength(1); // exactly one
  });
});

describe("protect refuses to touch an unparseable settings file (data-loss fix, 2026-09-29)", () => {
  it("flags parseError and does NOT rebuild from empty (JSONC with a deny rule)", () => {
    const dir = repo();
    mkdirSync(join(dir, ".claude"), { recursive: true });
    const jsonc = '{\n  // my model\n  "model": "opus",\n  "permissions": { "deny": ["Bash(git push:*)"] },\n}';
    writeFileSync(settings(dir), jsonc);
    const plan = planProtect(dir);
    expect(plan.parseError).toBe(true);
    expect(plan.next).toBe(jsonc); // unchanged
    expect(plan.toAdd).toEqual([]);
  });

  it("applyProtect leaves the file byte-identical on a parse error", () => {
    const dir = repo();
    mkdirSync(join(dir, ".claude"), { recursive: true });
    const jsonc = '{\n  "model": "opus", // keep\n  "permissions": { "deny": ["Bash(git push:*)"] },\n}';
    writeFileSync(settings(dir), jsonc);
    const before = readFileSync(settings(dir), "utf-8");
    const plan = planProtect(dir);
    expect(() => applyProtect(dir, plan)).toThrow(); // refuses
    expect(readFileSync(settings(dir), "utf-8")).toBe(before); // byte-identical
  });
});
