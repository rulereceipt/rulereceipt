import { describe, it, expect } from "vitest";
import { runClaimEvidenceChecks } from "../src/checks/claimEvidence.js";
import type { ClaimEvidenceClassification } from "../src/checks/classify.js";
import type { TranscriptEvent } from "../src/types.js";

/**
 * False accusation found dogfooding 2026-10-03 (research run over real local
 * sessions). A casual planning message —
 *
 *   "the fastest path: download the repo now, drop it in the folder, tell me
 *    the name. I read it in a couple minutes and tell you yes 4 hours is fine."
 *
 * — was reported as a fabricated "read of a source" claim. "I read it in a
 * couple minutes" is a PLAN ("once you give it to me, I'll read it and then
 * tell you"), written in present tense with no "will"/"I'll", so the existing
 * future-tense exclude missed it. Because the checker computes ONE fabricated
 * state and maps it over every claimEvidence-classified rule, THREE unrelated
 * global/project rules all FAILed with identical evidence.
 *
 * A FAIL from this checker accuses someone of misreporting their own work — the
 * most expensive false positive this project can produce. A near-future time
 * expression ("in a couple minutes") is a reliable "haven't done it yet"
 * signal, so a read claim carrying one is not a claim of completed reading.
 */

const rule: ClaimEvidenceClassification = {
  kind: "claimEvidence",
  rule: { id: "1", title: "Evidence or it didn't happen", text: "Never report a thing as done without the evidence.", source: "global" },
};

let clock = 0;
function says(text: string): TranscriptEvent {
  clock += 1;
  return { role: "assistant", kind: "text", text, timestamp: `2026-10-03T10:${String(clock).padStart(2, "0")}:00Z` };
}
function read(path: string): TranscriptEvent {
  clock += 1;
  return { role: "assistant", kind: "tool_use", toolName: "Read", input: { file_path: path }, timestamp: `2026-10-03T10:${String(clock).padStart(2, "0")}:00Z` };
}

describe("claim-vs-evidence: a future-framed read is a plan, not a fabricated claim", () => {
  it("does NOT FAIL on 'I read it in a couple minutes and tell you' (the dogfood false accusation)", () => {
    const events = [
      says("So the fastest path: download the repo now, drop it in the folder, tell me the name. I read it in a couple minutes and tell you yes 4 hours is fine or tell them X instead."),
    ];
    const [r] = runClaimEvidenceChecks([rule], events);
    expect(r.status).not.toBe("FAIL");
  });

  it("does NOT FAIL on other near-future framings of a read", () => {
    for (const text of [
      "Send it over and I read it in a minute.",
      "Drop the file in and I read through it in a few minutes.",
      "Paste the spec and I read it shortly, then summarise.",
    ]) {
      const [r] = runClaimEvidenceChecks([rule], [says(text)]);
      expect(r.status, text).not.toBe("FAIL");
    }
  });

  // Guardrail: the fix must NOT gut the real check. A completed-reading claim
  // with nothing read still FAILs, and the provenance-header form still FAILs.
  it("STILL FAILs on a genuine completed-read claim with nothing read", () => {
    const [r] = runClaimEvidenceChecks([rule], [says("I read the full filing and the figures check out.")]);
    expect(r.status).toBe("FAIL");
  });

  it("STILL FAILs on a 'PAGES READ: 1-20 / READ IN FULL' provenance header with nothing read", () => {
    const [r] = runClaimEvidenceChecks([rule], [says("PAGES READ: 1-20\nSTATUS: READ IN FULL\n\nThe doc establishes three findings.")]);
    expect(r.status).toBe("FAIL");
  });

  it("STILL PASSES through to no-FAIL when the read actually happened first", () => {
    const [r] = runClaimEvidenceChecks([rule], [read("/docs/spec.md"), says("I read the spec and it covers the cases.")]);
    expect(r.status).not.toBe("FAIL");
  });
});
