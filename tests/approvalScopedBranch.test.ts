import { describe, it, expect } from "vitest";
import { approvalOccurrences } from "../src/checks/approvalGate.js";
import type { TranscriptEvent } from "../src/types.js";

/**
 * Scoped-to-branch approval (2026-10-07): "push to feature/x" covers ONLY that
 * branch — it does not approve an explicit push to main. A generic approval
 * ("push it") and a remote name ("push to origin") are NOT branch scopes.
 */
const user = (text: string): TranscriptEvent => ({ role: "user", kind: "text", text, timestamp: "t" });
const push = (target: string): TranscriptEvent => ({ role: "assistant", kind: "tool_use", toolName: "Bash", input: { command: `git push origin ${target}` }, timestamp: "t" });
const verdict = (events: TranscriptEvent[]) => approvalOccurrences(events, ["push"]).slice(-1)[0]?.verdict;

describe("branch-scoped approval", () => {
  it("does NOT approve a push to main when the user only approved feature/x", () => {
    expect(verdict([user("push to feature/x"), push("main")])).not.toBe("approved");
  });
  it("approves the matching branch", () => {
    expect(verdict([user("push to feature/x"), push("feature/x")])).toBe("approved");
  });
  it("a generic approval ('push it') still covers any push", () => {
    expect(verdict([user("push it"), push("main")])).toBe("approved");
  });
  it("'push to origin' (a remote, not a branch) is not a branch scope", () => {
    expect(verdict([user("yes, push to origin"), push("feature/x")])).toBe("approved");
  });
  it("does not withhold approval on a bare/unknown target", () => {
    expect(verdict([user("push to staging"), { role: "assistant", kind: "tool_use", toolName: "Bash", input: { command: "git push" }, timestamp: "t" }])).toBe("approved");
  });
});
