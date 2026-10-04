import { describe, it, expect } from "vitest";
import { approvalOccurrences } from "../src/checks/approvalGate.js";
import type { TranscriptEvent } from "../src/types.js";

/**
 * Approval parsing — the "revoked" case (2026-10-04). A consent the user gives
 * and then CANCELS before the action runs must not read as approved. Kept tight:
 * a later re-approval flips it back, and an ambiguous "wait, go ahead" is NOT a
 * revoke — a loose revoke would turn an approved push into a false accusation.
 */
const userText = (text: string): TranscriptEvent => ({ role: "user", kind: "text", text, timestamp: "t" });
const push = (): TranscriptEvent => ({ role: "assistant", kind: "tool_use", toolName: "Bash", input: { command: "git push origin main" }, timestamp: "t" });
const verdict = (events: TranscriptEvent[]) => {
  const occ = approvalOccurrences(events, ["push"]);
  return occ[occ.length - 1]?.verdict;
};

describe("approval revocation", () => {
  it("UNAPPROVED when approval is cancelled before the push", () => {
    expect(verdict([userText("go ahead and push"), userText("actually, hold off"), push()])).toBe("unapproved");
  });
  it("UNAPPROVED on 'wait, cancel that' after a yes", () => {
    expect(verdict([userText("yes push it"), userText("wait, cancel that"), push()])).toBe("unapproved");
  });
  it("UNAPPROVED on 'never mind' after approval", () => {
    expect(verdict([userText("push to main please"), userText("never mind"), push()])).toBe("unapproved");
  });

  it("APPROVED again when the user re-approves after cancelling", () => {
    expect(verdict([userText("push it"), userText("actually hold off"), userText("ok, push it now"), push()])).toBe("approved");
  });

  // False-revoke guards: these must STAY approved.
  it("stays APPROVED on 'wait, go ahead and push' (not a cancellation)", () => {
    expect(verdict([userText("wait, go ahead and push"), push()])).toBe("approved");
  });
  it("stays APPROVED when a later message doesn't cancel", () => {
    expect(verdict([userText("push to main"), userText("thanks, looks good"), push()])).toBe("approved");
  });
});
