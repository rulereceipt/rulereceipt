import { describe, it, expect } from "vitest";
import { runClaimEvidenceChecks } from "../src/checks/claimEvidence.js";
import type { ClaimEvidenceClassification } from "../src/checks/classify.js";
import type { TranscriptEvent } from "../src/types.js";

/**
 * Results belong to the call whose id they carry, not to the call that
 * happens to sit above them.
 *
 * claimEvidence.ts documented the positional rule as safe, with a
 * measurement: "across 1,419 tool-calling turns in three real sessions,
 * every turn contained exactly one tool call, so there is no parallel
 * fan-out to mis-attribute." That was true when it was measured and is not
 * true now. Parallel tool calls are ordinary, and a real session on this
 * machine issues three in a row before any result arrives:
 *
 *   [45] tool_use    id=toolu_017xrjy...   <- the test run
 *   [46] tool_use    id=toolu_01X6ES3...
 *   [47] tool_use    id=toolu_01Qk95Y...
 *   [48] tool_result id=toolu_017xrjy...   <- belongs to 45, attributed to 47
 *
 * Under the positional rule event 46 cleared the pending test run, the
 * passing result was credited to an unrelated call, and a session that had
 * run its tests was reported as claiming success with nothing behind it.
 * Found 2026-09-16 by adjudicating a block instead of trusting it.
 *
 * Ids are used when present and position is the fallback, because older
 * transcripts and hand-built fixtures have no ids and must keep working.
 */
const rule = { id: "1", title: "Evidence", text: "Never report an item done without pasting the evidence.", source: "global" as const };
const cls = [{ kind: "claimEvidence", rule }] as unknown as ClaimEvidenceClassification[];

const use = (command: string, toolUseId?: string): TranscriptEvent =>
  ({ role: "assistant", kind: "tool_use", toolName: "Bash", input: { command }, timestamp: "t", toolUseId });
const res = (content: string, toolUseId?: string, isError = false): TranscriptEvent =>
  ({ role: "user", kind: "tool_result", content, isError, timestamp: "t", toolUseId });
const say = (text: string): TranscriptEvent => ({ role: "assistant", kind: "text", text, timestamp: "t" });

describe("parallel tool calls", () => {
  it("credits a passing run issued in a parallel batch", () => {
    const [r] = runClaimEvidenceChecks(cls, [
      use("npm test", "A"),
      use("cat ACCOUNTS.md", "B"),
      use("dig +short MX example.com", "C"),
      res(" Tests  5 passed (5)", "A"),
      res("contents", "B"),
      say("All tests pass."),
    ]);
    expect(r.unverifiedClaim).toBeFalsy();
    expect(r.status).toBe("PASS");
  });

  it("still catches a failing run issued in a parallel batch", () => {
    const [r] = runClaimEvidenceChecks(cls, [
      use("npm test", "A"),
      use("ls", "B"),
      res(" Tests  2 failed | 1 passed (3)", "A", true),
      res("a.txt", "B"),
      say("All tests pass."),
    ]);
    expect(r.status).toBe("FAIL");
  });

  it("still works on transcripts with no ids at all", () => {
    const [r] = runClaimEvidenceChecks(cls, [use("npm test"), res(" Tests  5 passed (5)"), say("All tests pass.")]);
    expect(r.status).toBe("PASS");
  });
});
