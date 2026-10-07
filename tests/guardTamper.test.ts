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

  // Must NOT fire (shadow signal still needs a low false rate):
  it("does not fire on ordinary edits or a normal push", () => {
    expect(detectGuardTamper([write("src/index.ts"), bash("git push origin feature/x"), bash("npm test")], { hasBranchRule: true })).toEqual([]);
  });
  it("does not fire on `git config` (not a --no-verify bypass)", () => {
    expect(detectGuardTamper([bash("git config user.name rulereceipt")], { hasBranchRule: true })).toEqual([]);
  });
  it("does not fire on editing a normal .json that isn't settings", () => {
    expect(detectGuardTamper([write("package.json"), write("tsconfig.json")], { hasBranchRule: true })).toEqual([]);
  });
});
