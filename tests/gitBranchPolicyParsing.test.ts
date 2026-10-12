import { describe, it, expect } from "vitest";
import {
  pushTargets, branchTargets, extractGitBranchTargets, segmentContaining,
  commitSegment, findCheckoutCommitViolation, runGitBranchPolicyChecks,
} from "../src/checks/gitBranchPolicy.js";
import type { GitBranchPolicyClassification } from "../src/checks/classify.js";
import type { TranscriptEvent } from "../src/types.js";

/**
 * Deep unit coverage of gitBranchPolicy's parsing helpers and result objects
 * (mutation-testing pass): each case is chosen to DISTINGUISH the real behavior
 * from a mutant, so a changed operator/literal/regex fails a test.
 */
const b = (branch: string, segment: string) => ({ branch, segment });

describe("pushTargets: the branch(es) a git push writes to", () => {
  it("plain push names the refspec, not the remote", () => {
    expect(pushTargets("git push origin main")).toEqual([b("main", "git push origin main")]);
  });
  it("ignores a bare `git push` (branch unknown)", () => {
    expect(pushTargets("git push")).toEqual([]);
  });
  it("skips flags: `-u` before the refspec", () => {
    expect(pushTargets("git push -u origin main")).toEqual([b("main", "git push -u origin main")]);
  });
  it("force flag after the refspec still finds it", () => {
    expect(pushTargets("git push origin main --force")).toEqual([b("main", "git push origin main --force")]);
  });
  it("a local:remote refspec targets the REMOTE side", () => {
    expect(pushTargets("git push origin HEAD:main")).toEqual([b("main", "git push origin HEAD:main")]);
  });
  it("a remote-branch delete `origin :main` targets main", () => {
    expect(pushTargets("git push origin :main")).toEqual([b("main", "git push origin :main")]);
  });
  it("a `+local:main` force refspec strips the + and targets main", () => {
    expect(pushTargets("git push origin +dev:main")).toEqual([b("main", "git push origin +dev:main")]);
  });
  it("config flags between git and push are allowed", () => {
    expect(pushTargets("git -c credential.helper= push origin main")).toEqual([b("main", "git -c credential.helper= push origin main")]);
  });
  it("multiple refspecs yield multiple targets", () => {
    expect(pushTargets("git push origin main dev")).toEqual([b("main", "git push origin main dev"), b("dev", "git push origin main dev")]);
  });
  it("only the git segment of a chained command is read, with that segment", () => {
    expect(pushTargets("echo hi && git push origin main")).toEqual([b("main", "git push origin main")]);
  });
  it("a non-git `push` command is ignored", () => {
    expect(pushTargets("npm run push origin main")).toEqual([]);
  });
});

describe("branchTargets: the branch(es) a git branch command creates/deletes/renames", () => {
  it("plain create targets the created name only", () => {
    expect(branchTargets("git branch feature")).toEqual([b("feature", "git branch feature")]);
  });
  it("plain create ignores the start-point", () => {
    expect(branchTargets("git branch feature origin/main")).toEqual([b("feature", "git branch feature origin/main")]);
  });
  it("-d deletes every named branch", () => {
    expect(branchTargets("git branch -d main dev")).toEqual([b("main", "git branch -d main dev"), b("dev", "git branch -d main dev")]);
  });
  it("-D (force delete) is recognised too", () => {
    expect(branchTargets("git branch -D main")).toEqual([b("main", "git branch -D main")]);
  });
  it("-m rename targets the NEW name (last positional)", () => {
    expect(branchTargets("git branch -m old main")).toEqual([b("main", "git branch -m old main")]);
  });
  it("bare `git branch` (list) yields nothing", () => {
    expect(branchTargets("git branch")).toEqual([]);
  });
});

describe("extractGitBranchTargets: kinds + segments", () => {
  it("checkout -b is a create", () => {
    expect(extractGitBranchTargets("git checkout -b main")).toContainEqual({ branch: "main", kind: "create", segment: "git checkout -b main" });
  });
  it("switch -c is a create", () => {
    expect(extractGitBranchTargets("git switch -c main")).toContainEqual({ branch: "main", kind: "create", segment: "git switch -c main" });
  });
  it("a bare checkout is a switch", () => {
    expect(extractGitBranchTargets("git checkout main")).toContainEqual({ branch: "main", kind: "switch", segment: "git checkout main" });
  });
  it("push is a push", () => {
    expect(extractGitBranchTargets("git push origin main")).toContainEqual({ branch: "main", kind: "push", segment: "git push origin main" });
  });
  it("in a multi-line block, the create segment is the matching line only", () => {
    const seg = extractGitBranchTargets("cd repo\ngit checkout -b main").find((h) => h.kind === "create")!.segment;
    expect(seg).toBe("git checkout -b main");
  });
});

describe("segmentContaining / commitSegment", () => {
  it("segmentContaining returns the line holding the match, trimmed", () => {
    expect(segmentContaining("gh auth switch\ncd r\ngit push origin main", "git push origin main")).toBe("git push origin main");
  });
  it("segmentContaining falls back to the whole command when no segment matches", () => {
    expect(segmentContaining("a single command", "zzz")).toBe("a single command");
  });
  it("commitSegment returns the git-commit segment", () => {
    expect(commitSegment("git checkout main && git commit -m 'x'")).toBe("git commit -m 'x'");
  });
  it("commitSegment falls back to the whole command when no commit segment", () => {
    expect(commitSegment("echo nope")).toBe("echo nope");
  });
});

describe("findCheckoutCommitViolation: commit while sitting on the named branch", () => {
  it("checkout then commit on the branch is the violation (returns the commit command)", () => {
    expect(findCheckoutCommitViolation(["git checkout main", "git commit -m x"], "main")).toBe("git commit -m x");
  });
  it("checkout a DIFFERENT branch then commit is not a violation", () => {
    expect(findCheckoutCommitViolation(["git checkout feature", "git commit -m x"], "main")).toBeNull();
  });
  it("checkout with no following commit is not a violation", () => {
    expect(findCheckoutCommitViolation(["git checkout main", "git status"], "main")).toBeNull();
  });
  it("checkout -b main then commit is a violation", () => {
    expect(findCheckoutCommitViolation(["git checkout -b main", "git commit -m x"], "main")).toBe("git commit -m x");
  });
});

function bash(command: string): TranscriptEvent {
  return { role: "assistant", kind: "tool_use", toolName: "Bash", input: { command }, timestamp: "t" };
}
const forbidMain: GitBranchPolicyClassification = {
  kind: "gitBranchPolicy",
  rule: { id: "9", title: "No push to main", text: "Never push to the `main` branch.", source: "project" },
  branchName: "main", polarity: "forbid",
};
const requireMain: GitBranchPolicyClassification = { ...forbidMain, rule: { ...forbidMain.rule, id: "10" }, polarity: "require" };

describe("runGitBranchPolicyChecks: exact result objects (kills literal/object mutants)", () => {
  it("forbid + push hit → full FAIL object", () => {
    const [r] = runGitBranchPolicyChecks([forbidMain], [bash("git push origin main")]);
    expect(r).toMatchObject({ ruleId: "9", ruleTitle: "No push to main", ruleSource: "project", status: "FAIL", outcome: "fail", method: "git_events" });
    expect(r.evidence).toBe('a git command actually targeted the "main" branch: git push origin main');
  });
  it("forbid + no hit (but git ran) → UNCLEAR / not_applicable with ceiling + exact evidence", () => {
    const [r] = runGitBranchPolicyChecks([forbidMain], [bash("git push origin dev")]);
    expect(r).toMatchObject({ status: "UNCLEAR", outcome: "not_applicable", method: "git_events" });
    expect(r.ceiling).toBe("a scan of recorded git commands — it does not see commands run outside this session");
    expect(r.evidence).toBe('no git command targeted the "main" branch this session');
  });
  it("no git command ran at all → UNCLEAR / not_applicable with its own evidence", () => {
    const [r] = runGitBranchPolicyChecks([forbidMain], [{ role: "assistant", kind: "text", text: "I pushed to main", timestamp: "t" }]);
    expect(r).toMatchObject({ status: "UNCLEAR", outcome: "not_applicable", method: "git_events" });
    expect(r.evidence).toBe("no git command ran this session, so this rule never applied");
  });
  it("require + hit → PASS with exact evidence", () => {
    const [r] = runGitBranchPolicyChecks([requireMain], [bash("git push origin main")]);
    expect(r.status).toBe("PASS");
    expect(r.evidence).toBe('a git command targeted the required "main" branch: git push origin main');
  });
  it("require + no hit → UNCLEAR with exact can't-tell evidence", () => {
    const [r] = runGitBranchPolicyChecks([requireMain], [bash("git push origin dev")]);
    expect(r.status).toBe("UNCLEAR");
    expect(r.evidence).toBe('no git command targeting the "main" branch appeared this session — can\'t tell if the rule didn\'t apply, or applied and was skipped');
  });
  it("forbid + checkout-then-commit on main → FAIL quoting the commit segment", () => {
    const [r] = runGitBranchPolicyChecks([forbidMain], [bash("git checkout main"), bash("git commit -m ship")]);
    expect(r.status).toBe("FAIL");
    expect(r.evidence).toBe('a git command actually targeted the "main" branch: git commit -m ship');
  });
});
