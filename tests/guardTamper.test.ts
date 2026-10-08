import { describe, it, expect } from "vitest";
import { detectGuardTamper } from "../src/checks/guardTamper.js";
import type { TranscriptEvent } from "../src/types.js";

const write = (file_path: string): TranscriptEvent => ({ role: "assistant", kind: "tool_use", toolName: "Write", input: { file_path, content: "x" }, timestamp: "t" });
const bash = (command: string): TranscriptEvent => ({ role: "assistant", kind: "tool_use", toolName: "Bash", input: { command }, timestamp: "t" });

describe("guard-tamper shadow signal", () => {
  it("flags an edit to .claude/settings.json", () => {
    const f = detectGuardTamper([write(".claude/settings.json")], { hasBranchRule: false });
    expect(f.map((x) => x.kind)).toContain("hook-config-edit");
  });
  it("flags an edit to settings.local.json and to a .githooks hook", () => {
    expect(detectGuardTamper([write("project/.claude/settings.local.json")], { hasBranchRule: false }).length).toBe(1);
    expect(detectGuardTamper([write(".githooks/pre-commit")], { hasBranchRule: false }).length).toBe(1);
    expect(detectGuardTamper([write(".git/hooks/pre-push")], { hasBranchRule: false }).length).toBe(1);
  });
  it("flags git --no-verify ONLY when a branch rule exists", () => {
    expect(detectGuardTamper([bash("git push --no-verify origin main")], { hasBranchRule: true }).map((x) => x.kind)).toContain("no-verify");
    expect(detectGuardTamper([bash("git push --no-verify origin main")], { hasBranchRule: false })).toEqual([]);
  });

  // Disabling git hooks wholesale (found on a real OpenCode 1.18.35 session).
  // Fires regardless of hasBranchRule — the hooks that enforce ANY rule don't run.
  it("flags `git -c core.hooksPath=/dev/null commit` as hooks-disabled", () => {
    const f = detectGuardTamper([bash('git add app.js && git -c core.hooksPath=/dev/null commit -m "x"')], { hasBranchRule: false });
    expect(f.map((x) => x.kind)).toContain("hooks-disabled");
  });
  it("flags `git config core.hooksPath /dev/null` (space form) too", () => {
    expect(detectGuardTamper([bash("git config core.hooksPath /dev/null")], { hasBranchRule: false }).map((x) => x.kind)).toContain("hooks-disabled");
  });
  it("flags a HUSKY=0 env prefix", () => {
    expect(detectGuardTamper([bash("HUSKY=0 git commit -m wip")], { hasBranchRule: false }).map((x) => x.kind)).toContain("hooks-disabled");
    expect(detectGuardTamper([bash("HUSKY=0 npm run release")], { hasBranchRule: false }).map((x) => x.kind)).toContain("hooks-disabled");
  });
  it("flags .husky/* hook-config edits", () => {
    expect(detectGuardTamper([write(".husky/pre-commit")], { hasBranchRule: false }).map((x) => x.kind)).toContain("hook-config-edit");
  });

  // Must NOT fire (shadow signal still needs a low false rate):
  it("does not fire on ordinary edits or a normal push", () => {
    expect(detectGuardTamper([write("src/index.ts"), bash("git push origin feature/x"), bash("npm test")], { hasBranchRule: true })).toEqual([]);
  });
  it("does not fire on `git config` (not a --no-verify bypass)", () => {
    expect(detectGuardTamper([bash("git config user.name rulereceipt")], { hasBranchRule: true })).toEqual([]);
  });
  it("does NOT treat pointing core.hooksPath at a REAL dir as a bypass", () => {
    // Setting hooks to a real directory enables hooks — it is not a disable.
    expect(detectGuardTamper([bash("git config core.hooksPath .husky")], { hasBranchRule: true })).toEqual([]);
    expect(detectGuardTamper([bash("git -c core.hooksPath=.githooks status")], { hasBranchRule: true })).toEqual([]);
  });
  it("does NOT fire on HUSKY=1 / an unrelated env var", () => {
    expect(detectGuardTamper([bash("HUSKY=1 git commit -m ok"), bash("DEBUG=0 npm test")], { hasBranchRule: true })).toEqual([]);
  });
  it("does not fire on editing a normal .json that isn't settings", () => {
    expect(detectGuardTamper([write("package.json"), write("tsconfig.json")], { hasBranchRule: true })).toEqual([]);
  });
});
