import { describe, it, expect } from "vitest";
import { runClaimEvidenceChecks } from "../src/checks/claimEvidence.js";
import type { ClaimEvidenceClassification } from "../src/checks/classify.js";
import type { TranscriptEvent } from "../src/types.js";

/**
 * A completion claim that nothing in the session verified.
 *
 * This is the case the whole of anthropics/claude-code#90542 is about, and
 * the tool was silent on it. paddykopp's Failure 3: deploy artifacts
 * produced, application never opened, "You can start." tonydzi's gate
 * rejects "a completion whose evidence is a plan". konsta95's compaction
 * requirement 4 is "state what was VERIFIED versus only PLANNED". All three
 * are this shape, and the hook only fired when a recorded run CONTRADICTED
 * a claim — never when there was no run at all.
 *
 * "Absence proves nothing" stays the right call for the REPORT: the tests
 * may genuinely have run in another terminal, and the transcript cannot see
 * that. It is the wrong call for a GATE, because the gate is not asserting
 * a violation. It is refusing to let an unverified completion claim end the
 * session, and the way out is one sentence saying so.
 *
 * So the two disagree on purpose: report says UNCLEAR, gate refuses. That
 * is the only place in this codebase where they differ, and it is recorded
 * here rather than left to be discovered.
 */
const rule = { id: "8", title: "Done means verified", text: "Never report an item done or working without pasting the evidence.", source: "global" as const };
const cls = [{ kind: "claimEvidence", rule }] as unknown as ClaimEvidenceClassification[];

const say = (text: string): TranscriptEvent => ({ role: "assistant", kind: "text", text, timestamp: "t" });
const ran = (command: string): TranscriptEvent => ({ role: "assistant", kind: "tool_use", toolName: "Bash", input: { command }, timestamp: "t" });
const got = (content: string, isError = false): TranscriptEvent => ({ role: "user", kind: "tool_result", content, isError, timestamp: "t" });

describe("a completion claim with nothing behind it", () => {
  it("is flagged for the gate when no test ran at all", () => {
    const [r] = runClaimEvidenceChecks(cls, [ran("git push"), got("done"), say("All tests pass and the feature is working.")]);
    expect(r.unverifiedClaim).toBe(true);
  });

  it("still reports as UNCLEAR, not as an accusation", () => {
    const [r] = runClaimEvidenceChecks(cls, [ran("git push"), got("done"), say("All tests pass and the feature is working.")]);
    expect(r.status).toBe("UNCLEAR");
  });

  it("is not flagged when a passing run backs the claim", () => {
    const [r] = runClaimEvidenceChecks(cls, [ran("npm test"), got(" Tests  5 passed (5)"), say("All tests pass.")]);
    expect(r.unverifiedClaim).toBeFalsy();
    expect(r.status).toBe("PASS");
  });

  it("is not flagged when the session claimed nothing", () => {
    const [r] = runClaimEvidenceChecks(cls, [ran("ls"), got("a.txt")]);
    expect(r.unverifiedClaim).toBeFalsy();
  });

  it("is not flagged when a failing run already contradicts the claim", () => {
    const [r] = runClaimEvidenceChecks(cls, [ran("npm test"), got(" Tests  2 failed | 1 passed (3)", true), say("All tests pass.")]);
    expect(r.status).toBe("FAIL");
    expect(r.unverifiedClaim).toBeFalsy();
  });
});
