import { describe, it, expect } from "vitest";
import { classifyRules } from "../src/checks/classify.js";
import { runClaimEvidenceChecks } from "../src/checks/claimEvidence.js";
import type { TranscriptEvent } from "../src/types.js";

/**
 * ReDoS regression (2026-10-05). NOT_A_CLAIM's contraction arm was `\w+n't`,
 * which backtracks quadratically on a long word with no "n't" — a ~1MB session
 * stalled the whole pipeline for ~40s (and the guard runs as a PreToolUse hook,
 * so a large transcript could hang Claude Code). Fixed with a lookbehind plus a
 * sentence-length cap. This asserts a 200k-char text event is processed fast.
 */
describe("claimEvidence is linear on large untrusted text (ReDoS guard)", () => {
  const cls = classifyRules([{ id: "1", title: "t", text: "Do not say tests pass without running them.", source: "project" }]);
  const of = cls.filter((c) => c.kind === "claimEvidence") as never;

  it("processes a 200k-char single-sentence text event in well under 2s (was ~42s)", () => {
    const events: TranscriptEvent[] = [{ role: "assistant", kind: "text", text: "tests pass " + "a".repeat(200000), timestamp: "t" }];
    const start = performance.now();
    runClaimEvidenceChecks(of, events);
    const ms = performance.now() - start;
    expect(ms, `took ${ms.toFixed(0)}ms`).toBeLessThan(2000);
  });
});
