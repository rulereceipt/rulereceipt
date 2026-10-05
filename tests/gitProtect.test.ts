import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { branchesFromPrePushStdin, evaluateGitPush, planGitProtect, applyGitProtect, undoGitProtect } from "../src/gitProtect.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rr-gitp-"));
  writeFileSync(join(dir, "CLAUDE.md"), "## Branch\nNever push to the `main` branch directly.\n");
  mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const sha = "a".repeat(40);
const zero = "0".repeat(40);

describe("pre-push stdin parsing", () => {
  it("extracts the remote branch, skipping a deletion", () => {
    const stdin = `refs/heads/main ${sha} refs/heads/main ${zero}\nrefs/heads/gone ${zero} refs/heads/gone ${sha}\n`;
    expect(branchesFromPrePushStdin(stdin)).toEqual(["main"]);
  });
});

describe("evaluateGitPush (reuses guardDecision)", () => {
  it("blocks a push to main that a rule forbids, and points at --no-verify", () => {
    const r = evaluateGitPush(dir, `refs/heads/main ${sha} refs/heads/main ${zero}\n`);
    expect(r.block).toBe(true);
    expect(r.messages.join("\n")).toMatch(/main/);
    expect(r.messages.join("\n")).toMatch(/--no-verify/);
  });
  it("does not block a push to a feature branch", () => {
    const r = evaluateGitPush(dir, `refs/heads/feature/x ${sha} refs/heads/feature/x ${zero}\n`);
    expect(r.block).toBe(false);
  });
  it("does not block when there are no refs", () => {
    expect(evaluateGitPush(dir, "").block).toBe(false);
  });
});

describe("protect --git install / undo", () => {
  it("installs an executable pre-push hook, then undo removes it", () => {
    const plan = planGitProtect(dir);
    expect(plan.notAGitRepo).toBe(false);
    expect(plan.alreadyProtected).toBe(false);
    applyGitProtect(dir, plan);
    const hook = join(dir, ".git", "hooks", "pre-push");
    expect(existsSync(hook)).toBe(true);
    expect(readFileSync(hook, "utf-8")).toContain("rulereceipt git-guard");
    expect(statSync(hook).mode & 0o111).toBeGreaterThan(0); // executable
    expect(planGitProtect(dir).alreadyProtected).toBe(true); // idempotent

    const u = undoGitProtect(dir);
    expect(u.ok).toBe(true);
    expect(existsSync(hook)).toBe(false);
  });

  it("refuses to overwrite a foreign pre-push hook", () => {
    writeFileSync(join(dir, ".git", "hooks", "pre-push"), "#!/bin/sh\necho mine\n");
    const plan = planGitProtect(dir);
    expect(plan.foreignHook).toBe(true);
    expect(() => applyGitProtect(dir, plan)).toThrow();
  });

  it("reports not-a-git-repo when there is no .git", () => {
    const bare = mkdtempSync(join(tmpdir(), "rr-nogit-"));
    try {
      expect(planGitProtect(bare).notAGitRepo).toBe(true);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});
