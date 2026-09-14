import { describe, it, expect } from "vitest";
import { runClaimEvidenceChecks } from "../src/checks/claimEvidence.js";
import type { ClaimEvidenceClassification } from "../src/checks/classify.js";
import type { TranscriptEvent } from "../src/types.js";

/**
 * One command, two test runs, and the second one is SUPPOSED to fail.
 *
 * Verbatim from a real session, found 2026-09-14 while measuring how often
 * the Stop hook would fire: across twelve real sessions it fired once, and
 * that once was wrong. The session ran a typecheck, then the suite (37
 * passed), then deliberately broke locking to prove the concurrency tests
 * can fail - which is the project's own Rule 7, "tests must be able to
 * fail". It then said "Everything passes:", which was true.
 *
 * The checker read "2 failed" out of the deliberate red run, attributed it
 * to the whole command, and called the session a liar. Output-reading
 * overrides the pipe guard on purpose ("prefer what the runner SAID over
 * what the shell returned"), so the pipes in this command did not save it.
 *
 * The fix is not to recognise deliberate failures - that is unknowable. It
 * is that a command invoking the suite more than once has no single outcome
 * to attribute, exactly like a piped one.
 */
const COMMAND = "cd ~/Desktop/ravikiran/assignment/be || exit 1\necho \"========== 1. TYPECHECK ==========\"\nnpx tsc --noEmit && echo \"  PASS\" || echo \"  FAIL\"\necho\necho \"========== 2. FULL TEST SUITE ==========\"\nnpx vitest run 2>&1 | tail -5\necho\necho \"========== 3. CONCURRENCY TESTS PROVABLY FAIL (DISABLE_LOCKS=1) ==========\"\nDISABLE_LOCKS=1 npx vitest run tests/concurrency.test.ts 2>&1 | grep -E 'Tests|failed' | tail -3";
const OUTPUT = "========== 1. TYPECHECK ==========\n  PASS\n\n========== 2. FULL TEST SUITE ==========\n Test Files  9 passed (9)\n      Tests  37 passed (37)\n   Start at  14:32:46\n   Duration  390ms (transform 243ms, setup 0ms, collect 666ms, tests 100ms, environment 1ms, prepare 487ms)\n\n\n========== 3. CONCURRENCY TESTS PROVABLY FAIL (DISABLE_LOCKS=1) ==========\n     30|     for (const f of failed) {\n Test Files  1 failed (1)\n      Tests  2 failed | 1 passed (3)\nShell cwd was reset to /Users/shilpa/Desktop/Shilpa";

const rule = { id: "1", title: "Evidence or it didn't happen", text: "Never report an item done without pasting the evidence.", source: "global" as const };
const cls = [{ kind: "claimEvidence", rule }] as unknown as ClaimEvidenceClassification[];

const events: TranscriptEvent[] = [
  { role: "assistant", kind: "tool_use", toolName: "Bash", input: { command: COMMAND }, timestamp: "t1" },
  { role: "user", kind: "tool_result", content: OUTPUT, isError: false, timestamp: "t2" },
  { role: "assistant", kind: "text", text: "Everything passes:", timestamp: "t3" },
];

describe("a command containing two test runs has no attributable outcome", () => {
  it("does not accuse the session when the second run is a deliberate red run", () => {
    const [result] = runClaimEvidenceChecks(cls, events);
    expect(result.status).not.toBe("FAIL");
  });

  it("still catches a single run that really failed", () => {
    const single: TranscriptEvent[] = [
      { role: "assistant", kind: "tool_use", toolName: "Bash", input: { command: "npm test" }, timestamp: "t1" },
      { role: "user", kind: "tool_result", content: " Test Files  1 failed (1)\n      Tests  2 failed | 1 passed (3)", isError: true, timestamp: "t2" },
      { role: "assistant", kind: "text", text: "All tests pass.", timestamp: "t3" },
    ];
    expect(runClaimEvidenceChecks(cls, single)[0].status).toBe("FAIL");
  });
});
