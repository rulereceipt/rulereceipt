import { describe, it, expect } from "vitest";
import { classifyRules } from "../src/checks/classify.js";
import { parseClaudeMdText } from "../src/parsers/claudeMdParser.js";
import { checkSessionInBrowser } from "../src/browser/evaluateBrowser.js";

/**
 * "Never push to `main`" is the single most common branch rule people write,
 * and it was being missed: gitBranchPolicy required the literal word "branch"
 * AND a backticked name, so only "push to the `main` branch" fired. Found in
 * the full-tool validation 2026-09-29. The fix: a git ref-action verb
 * (push/commit/merge/rebase) plus a backticked, branch-shaped literal is a
 * branch rule too — but a bare "push to main" (no delimiter) stays UNCLEAR, to
 * keep a common English word from being read as a branch, and a file token
 * (`.env`, `dist/`) is never treated as a branch.
 */
const kindOf = (text: string) => (classifyRules(parseClaudeMdText(text, "project"))[0] as { kind: string }).kind;
const session = JSON.stringify({ type: "assistant", timestamp: "t", message: { role: "assistant", content: [{ type: "tool_use", id: "a", name: "Bash", input: { command: "git push origin main" } }] } });
const verdict = (text: string) => checkSessionInBrowser(text, session).results.find((r) => /push|commit|branch/i.test(r.ruleTitle))?.status ?? checkSessionInBrowser(text, session).results[0]?.status ?? "none";

describe("common branch-rule phrasings are caught", () => {
  it("'Never push to `main`.' (backtick, no word 'branch') is a branch rule and FAILs a push to main", () => {
    expect(kindOf("## 1. x\nNever push to `main`.")).toBe("gitBranchPolicy");
    expect(verdict("## 1. x\nNever push to `main`.")).toBe("FAIL");
  });
  it("'Do not commit to `master`.' is a branch rule", () => {
    expect(kindOf("## 1. x\nDo not commit to `master`.")).toBe("gitBranchPolicy");
  });
  it("'push directly to the `main` branch' still works (unchanged)", () => {
    expect(kindOf("## 1. x\nNever push directly to the `main` branch.")).toBe("gitBranchPolicy");
  });
});

describe("it does not over-reach", () => {
  it("bare 'Never push to main' (no backtick) is NOT forced to a branch FAIL", () => {
    // no delimited branch name — a common English word must not be read as a ref
    expect(kindOf("## 1. x\nNever push to main.")).not.toBe("gitBranchPolicy");
  });
  it("a file token in a push rule is not treated as a branch", () => {
    expect(kindOf("## 1. x\nNever push `.env` to the remote.")).not.toBe("gitBranchPolicy");
  });
});
