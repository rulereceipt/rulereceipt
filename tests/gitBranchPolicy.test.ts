import { describe, it, expect } from "vitest";
import { runGitBranchPolicyChecks } from "../src/checks/gitBranchPolicy.js";
import type { GitBranchPolicyClassification } from "../src/checks/classify.js";
import type { TranscriptEvent } from "../src/types.js";

function bash(command: string): TranscriptEvent {
  return { role: "assistant", kind: "tool_use", toolName: "Bash", input: { command }, timestamp: "2026-08-30T00:00:00Z" };
}

function textEvent(text: string): TranscriptEvent {
  return { role: "assistant", kind: "text", text, timestamp: "2026-08-30T00:00:00Z" };
}

const forbidDemoRule: GitBranchPolicyClassification = {
  kind: "gitBranchPolicy",
  rule: { id: "30", title: "No demo branch", text: "Never touch the `demo` branch.", source: "project" },
  branchName: "demo",
  polarity: "forbid",
};

describe("runGitBranchPolicyChecks", () => {
  // this is the exact real false-positive found 2026-08-30: a rule
  // about a branch named "demo" must not match a REPO named "demo",
  // a directory, or a sentence that merely mentions the word
  it("does NOT fail when 'demo' appears only as a repo/directory name, never as a git branch argument", () => {
    const events = [bash("cd acme-demo && ls"), textEvent("Looking at the acme demo repo now.")];
    const [result] = runGitBranchPolicyChecks([forbidDemoRule], events);
    expect(result.status).toBe("PASS");
  });

  it("does NOT fail when 'demo' appears in unrelated prose", () => {
    const events = [textEvent("I'll give a demo of this feature once it's done.")];
    const [result] = runGitBranchPolicyChecks([forbidDemoRule], events);
    expect(result.status).toBe("PASS");
  });

  // stronger version of the same real bug: a real GIT command that
  // mentions "demo" as part of something other than the branch argument
  // (here, a path filter on `git log`) must not trigger — only checkout/
  // switch/branch/push commands whose ARGUMENT is the branch name should
  it("does NOT fail when 'demo' appears inside a git command but not as a checkout/switch/branch/push argument", () => {
    const events = [bash("git log --oneline -- acme-demo/")];
    const [result] = runGitBranchPolicyChecks([forbidDemoRule], events);
    expect(result.status).toBe("PASS");
  });

  it("correctly FAILs when git checkout actually targets the named branch", () => {
    const events = [bash("git checkout demo")];
    const [result] = runGitBranchPolicyChecks([forbidDemoRule], events);
    expect(result.status).toBe("FAIL");
  });

  it("correctly FAILs when git switch actually targets the named branch", () => {
    const events = [bash("git switch demo")];
    const [result] = runGitBranchPolicyChecks([forbidDemoRule], events);
    expect(result.status).toBe("FAIL");
  });

  it("correctly FAILs when git checkout -b creates and switches to the named branch", () => {
    const events = [bash("git checkout -b demo")];
    const [result] = runGitBranchPolicyChecks([forbidDemoRule], events);
    expect(result.status).toBe("FAIL");
  });

  it("correctly FAILs when git branch creates the named branch", () => {
    const events = [bash("git branch demo")];
    const [result] = runGitBranchPolicyChecks([forbidDemoRule], events);
    expect(result.status).toBe("FAIL");
  });

  it("correctly FAILs when git push actually pushes to the named branch", () => {
    const events = [bash("git push origin demo")];
    const [result] = runGitBranchPolicyChecks([forbidDemoRule], events);
    expect(result.status).toBe("FAIL");
  });

  it("does NOT fail when checking out a DIFFERENT branch", () => {
    const events = [bash("git checkout main")];
    const [result] = runGitBranchPolicyChecks([forbidDemoRule], events);
    expect(result.status).toBe("PASS");
  });

  it("PASSes on a completely empty session", () => {
    const [result] = runGitBranchPolicyChecks([forbidDemoRule], []);
    expect(result.status).toBe("PASS");
  });

  it("includes the actual command in the evidence when it FAILs", () => {
    const events = [bash("git checkout demo")];
    const [result] = runGitBranchPolicyChecks([forbidDemoRule], events);
    expect(result.evidence).toContain("git checkout demo");
  });

  describe("require polarity", () => {
    const requireMainRule: GitBranchPolicyClassification = {
      kind: "gitBranchPolicy",
      rule: { id: "31", title: "Always merge to main", text: "Always push finished work to the `main` branch.", source: "project" },
      branchName: "main",
      polarity: "require",
    };

    it("PASSes when the required branch was actually targeted", () => {
      const events = [bash("git push origin main")];
      const [result] = runGitBranchPolicyChecks([requireMainRule], events);
      expect(result.status).toBe("PASS");
    });

    it("reports UNCLEAR, never a fabricated FAIL, when the required branch never appears", () => {
      const events = [bash("git status")];
      const [result] = runGitBranchPolicyChecks([requireMainRule], events);
      expect(result.status).toBe("UNCLEAR");
    });
  });
});
