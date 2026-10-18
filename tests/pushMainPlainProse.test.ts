import { describe, it, expect } from "vitest";
import { classifyRule } from "../src/checks/classify.js";
import { runGitBranchPolicyChecks } from "../src/checks/gitBranchPolicy.js";
import type { GitBranchPolicyClassification } from "../src/checks/classify.js";
import type { Rule, TranscriptEvent } from "../src/types.js";

/**
 * 0.1.111 (Builder B): a rule written in PLAIN PROSE — "never push to main",
 * "never push directly to the main branch" — must FAIL on a real, SUCCESSFUL
 * push to that branch, the same as the backticked form ("never push to
 * `main`"). Before this it classified as judgment/UNCLEAR.
 *
 * The whole product is zero false accusations, so the broadened classifier
 * must NOT fire on: "main"/"master" as an ordinary word, a push to a DIFFERENT
 * branch, a push that FAILED, or a rule that only mentions a branch without
 * forbidding a push to it.
 */

const rule = (text: string, title = "Branch policy"): Rule => ({ id: "1", title, text, source: "project" });
const classify = (text: string, title?: string) =>
  classifyRule(rule(text, title)) as { kind: string; branchName?: string; polarity?: string };

const bash = (command: string, toolUseId?: string): TranscriptEvent => ({
  role: "assistant",
  kind: "tool_use",
  toolName: "Bash",
  input: { command },
  timestamp: "t",
  ...(toolUseId ? { toolUseId } : {}),
});
const errResult = (toolUseId?: string): TranscriptEvent => ({
  role: "user",
  kind: "tool_result",
  content: "error: failed to push some refs to 'origin'",
  isError: true,
  timestamp: "t",
  ...(toolUseId ? { toolUseId } : {}),
});
const okResult = (toolUseId?: string): TranscriptEvent => ({
  role: "user",
  kind: "tool_result",
  content: "To github.com:acme/repo.git\n   a1b2c3..d4e5f6  main -> main",
  isError: false,
  timestamp: "t",
  ...(toolUseId ? { toolUseId } : {}),
});

const asBranch = (text: string, title?: string): GitBranchPolicyClassification => {
  const c = classifyRule(rule(text, title));
  if (c.kind !== "gitBranchPolicy") throw new Error(`expected gitBranchPolicy, got ${c.kind}`);
  return c;
};
const statusFor = (ruleText: string, events: TranscriptEvent[]) =>
  runGitBranchPolicyChecks([asBranch(ruleText)], events)[0].status;

describe("plain-prose branch policy is classified like the backticked form", () => {
  it("'never push to main' routes to gitBranchPolicy with branch main, forbid", () => {
    const c = classify("Never push to main.");
    expect(c.kind).toBe("gitBranchPolicy");
    expect(c.branchName).toBe("main");
    expect(c.polarity).toBe("forbid");
  });

  it("'never push directly to the main branch' routes to gitBranchPolicy with branch main", () => {
    const c = classify("Never push directly to the main branch.");
    expect(c.kind).toBe("gitBranchPolicy");
    expect(c.branchName).toBe("main");
  });

  it("'do not push to master' routes to gitBranchPolicy with branch master", () => {
    const c = classify("Do not push to master.");
    expect(c.kind).toBe("gitBranchPolicy");
    expect(c.branchName).toBe("master");
  });

  it("'never push to the release branch' routes to gitBranchPolicy with that named branch", () => {
    const c = classify("Never push to the release branch.");
    expect(c.kind).toBe("gitBranchPolicy");
    expect(c.branchName).toBe("release");
  });

  // 0.1.112: the prose path is PUSH-only. "never commit to main" names a
  // different action than the push the checker observes, so routing it to a
  // branch FAIL would hard-FAIL a `git push origin main` on a rule that is
  // often a workflow-step comment ("# 1. Confirm branch state — never commit
  // to main", tryvit) — a false FAIL caught by frozen-44. It routes to judgment
  // (couldn't tell) instead. The backtick form "never commit to `main`" is
  // unaffected (it is explicit).
  it("'never commit to main' routes to judgment (push-only prose path), never a FAIL", () => {
    expect(classify("Never commit to main.").kind).toBe("judgment");
  });

  // The "branch 'or'" false FAIL (frozen-44): a compound branch phrasing must
  // NEVER capture a conjunction/filler as the branch name. Asserted on
  // branchName UNCONDITIONALLY (undefined for the judgment cases, "main" when a
  // clean default is read) so it is not vacuous: it fails loudly the moment a
  // regression loosens the capture to re-grab "or"/"and"/"trunk"/"develop".
  it("never captures a conjunction/filler as the branch (the 'or' false FAIL)", () => {
    const FILLER = ["or", "and", "nor", "trunk", "develop"];
    for (const t of [
      "Never push to main or trunk.",
      "Never commit to main or develop.",
      "Protect the main or release branch.",
      "Keep main and trunk protected.",
    ]) {
      const c = classify(t) as { kind: string; branchName?: string };
      expect(FILLER).not.toContain(c.branchName ?? "");
    }
  });
});

describe("plain-prose push-to-main FAILs a real successful push", () => {
  it("'Never push to main.' + a successful push to main → FAIL", () => {
    expect(statusFor("Never push to main.", [bash("git push origin main")])).toBe("FAIL");
  });

  it("'Never push directly to the main branch.' + a successful push to main → FAIL", () => {
    expect(statusFor("Never push directly to the main branch.", [bash("git push origin main")])).toBe("FAIL");
  });

  it("a push to main with an explicit OK result still FAILs", () => {
    expect(statusFor("Never push to main.", [bash("git push origin main", "u1"), okResult("u1")])).toBe("FAIL");
  });
});

describe("zero false accusations — the broadened classifier must not over-reach", () => {
  it("'main' as an ordinary adjective is not a branch rule (the main function)", () => {
    expect(classify("Always keep the main function small.").kind).not.toBe("gitBranchPolicy");
  });

  it("'main' as an ordinary noun is not a branch rule (the main goal)", () => {
    expect(classify("The main goal of the project is reliability; document every decision.").kind)
      .not.toBe("gitBranchPolicy");
  });

  it("'our main concern' is not a branch rule", () => {
    expect(classify("Our main concern is latency, so always profile before optimizing.").kind)
      .not.toBe("gitBranchPolicy");
  });

  it("a rule that merely mentions the main branch without forbidding a push is not a branch rule", () => {
    expect(classify("Document which features shipped on the main branch.").kind).not.toBe("gitBranchPolicy");
  });

  it("'main' used as an adjective inside a push sentence is not a branch rule", () => {
    expect(classify("Push your main changes to the feature branch first.").kind).not.toBe("gitBranchPolicy");
  });

  it("a backticked file token in a push rule is still not a branch (no regression)", () => {
    expect(classify("Never push `.env` to the remote.").kind).not.toBe("gitBranchPolicy");
  });
});

describe("the checker only FAILs on a SUCCESSFUL push to the named branch", () => {
  it("does NOT FAIL on a push to a DIFFERENT branch", () => {
    expect(statusFor("Never push to main.", [bash("git push origin feature/x")])).not.toBe("FAIL");
  });

  it("does NOT FAIL when the push to main FAILED (error tool_result, matched by id)", () => {
    expect(statusFor("Never push to main.", [bash("git push origin main", "u1"), errResult("u1")])).not.toBe("FAIL");
  });

  it("does NOT FAIL when the push to main FAILED (error tool_result, positional)", () => {
    expect(statusFor("Never push to main.", [bash("git push origin main"), errResult()])).not.toBe("FAIL");
  });
});

describe("require-polarity prose never fabricates a FAIL", () => {
  it("a CLEAN positive push-to-main rule routes require and a push to main is PASS, not FAIL", () => {
    const c = classify("Always push to main.");
    expect(c.kind).toBe("gitBranchPolicy");
    expect(c.polarity).toBe("require");
    expect(statusFor("Always push to main.", [bash("git push origin main")])).toBe("PASS");
  });
  // 0.1.112 narrowing: an OBJECT between the verb and the preposition ("push
  // finished work to main") routes to judgment ("couldn't tell"), not a branch
  // check. Accepting the miss is the price of rejecting the symmetric negative
  // false FAILs ("push secrets to main") — a miss is acceptable, a false FAIL
  // is not (fa-corpus-v5).
  it("an object-bearing phrasing routes to judgment (couldn't tell), so it can never FAIL", () => {
    // judgment produces UNCLEAR, never a hard FAIL — routing here IS the safety.
    expect(classify("Always push finished work to main.").kind).toBe("judgment");
    expect(classify("Avoid pushing secrets to main.").kind).toBe("judgment");
  });
});
