import { describe, it, expect } from "vitest";
import { classifyRule } from "../src/checks/classify.js";

/**
 * The branch-policy checker may only be handed something that could name a
 * branch.
 *
 * It took the FIRST backtick literal in any rule containing the word
 * "branch" and treated it as one, unconditionally. Measured 2026-09-14
 * across 559 public rules files: of 70 rules routed here, 37 (52.9%) were
 * given a "branch name" that cannot be a branch - a naming TEMPLATE
 * ("squad/{issue-number}-{kebab-case-slug}"), a whole command
 * ("gh workflow run <WorkflowName> --ref <branch>"), and in one case an
 * entire fenced markdown block. The report then read, verbatim: "no git
 * command targeted the `git push --force` branch this session".
 *
 * Named as the open leftover by a reader of anthropics/claude-code#90542 on
 * 2026-09-14: the trigger was the word "branch" appearing anywhere, when it
 * needed to be a literal that could name one.
 *
 * This matters more than it did yesterday: gitBranchPolicy is one of the
 * checkers allowed to report a confident FAIL, and a FAIL now blocks a
 * session through the Stop hook.
 */
const classify = (title: string, text: string) =>
  classifyRule({ id: "1", title, text, source: "project" }) as { kind: string; branchName?: string };

describe("branch policy only accepts a literal that could name a branch", () => {
  it("routes a plain branch name", () => {
    const c = classify("Protected branches", "Never push directly to the `main` branch.");
    expect(c.kind).toBe("gitBranchPolicy");
    expect(c.branchName).toBe("main");
  });

  it("routes a branch name containing a slash", () => {
    const c = classify("Protected branches", "Never force-push the `release/2.1` branch.");
    expect(c.kind).toBe("gitBranchPolicy");
    expect(c.branchName).toBe("release/2.1");
  });

  it("does not treat a command as a branch name", () => {
    expect(classify("Force push", "Never use `git push --force` on a shared branch.").kind)
      .not.toBe("gitBranchPolicy");
  });

  it("does not treat a naming template as a branch name (verbatim, public corpus)", () => {
    expect(classify("Branch Naming", "Use the squad branch convention:\n```\nsquad/{issue-number}-{kebab-case-slug}\n```\nExample: `squad/42-fix-login-validation`").kind).not.toBe("gitBranchPolicy");
  });

  // Regression guard, not a reproduction: this phrasing routes to judgment
  // today for unrelated reasons. It is here so that a future change to the
  // branch trigger cannot quietly start reading a git subcommand as a ref.
  it("guard: never reads `git config user.name` as a branch name", () => {
    expect(classify("Identity", "Check `git config user.name` before committing to any branch.").kind)
      .not.toBe("gitBranchPolicy");
  });
});
