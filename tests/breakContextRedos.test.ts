import { describe, it, expect } from "vitest";
import { evidenceLineIndex } from "../src/breakContext.js";

/**
 * Pen-test (2026-10-22): ReDoS in evidence path-extraction.
 *
 * `needles()` (via evidenceLineIndex) ran a global regex over the WHOLE evidence
 * string whose two alternatives each matched a long non-delimiter run greedily,
 * then backtracked character-by-character at every start position looking for a
 * '/' or a '.ext' — O(n^2). Evidence comes from untrusted session content, and
 * this runs once per verdict when placing the timeline / break context, so a
 * crafted session with a long unbroken token could stall `check --timeline`.
 *
 * Measured before the fix: 2k->8ms, 4k->23ms, 8k->113ms, 16k->455ms (quadratic).
 * This pins the extraction to linear time on a pathological input.
 */
describe("evidence path-extraction is not ReDoS-prone", () => {
  it("places a verdict in linear time on a huge unbroken token (no / or .)", () => {
    const evidence = "the agent did " + "a".repeat(200_000) + " then stopped";
    const lines = ["unrelated line one", "unrelated line two"];
    const t0 = performance.now();
    const idx = evidenceLineIndex(lines, evidence);
    const dt = performance.now() - t0;
    // 200k chars of a single word-char run must stay well under a budget that a
    // quadratic scan (seconds at this size) could never meet.
    expect(dt).toBeLessThan(200);
    expect(idx).toBe(-1); // nothing matches; the point is that it returns quickly
  });

  it("still locates a real file-path needle at the correct line", () => {
    const lines = [
      "first line",
      "Edit on src/payments/charge.ts — wrote 3 lines",
      "later unrelated line",
    ];
    const evidence = 'edited the file src/payments/charge.ts in this session';
    expect(evidenceLineIndex(lines, evidence)).toBe(1);
  });

  it("still locates a dotted filename needle (e.g. .env.local)", () => {
    const lines = ["nothing here", "wrote to config.prod.json at the end"];
    const evidence = "the session wrote config.prod.json";
    expect(evidenceLineIndex(lines, evidence)).toBe(1);
  });
});
