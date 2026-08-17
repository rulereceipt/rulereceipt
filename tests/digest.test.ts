import { describe, it, expect } from "vitest";
import { generateDigest } from "../src/digest.js";
import type { HistoryEntry } from "../src/history.js";

function entry(overrides: Partial<HistoryEntry>): HistoryEntry {
  return { timestamp: "2026-08-17T00:00:00.000Z", pass: 5, fail: 0, unclear: 1, sessionFilePath: null, ...overrides };
}

describe("generateDigest", () => {
  it("says clearly when there's nothing to summarize", () => {
    const text = generateDigest([], "weekly");
    expect(text).toContain("No sessions checked in this period");
  });

  it("counts total sessions correctly", () => {
    const text = generateDigest([entry({}), entry({}), entry({})], "weekly");
    expect(text).toContain("3 sessions checked");
  });

  it("uses singular 'session' for exactly one entry (real grammar check, not cosmetic)", () => {
    const text = generateDigest([entry({})], "weekly");
    expect(text).toContain("1 session checked");
    expect(text).not.toContain("1 sessions");
  });

  it("splits clean vs failed correctly", () => {
    const text = generateDigest([entry({ fail: 0 }), entry({ fail: 0 }), entry({ fail: 2 })], "weekly");
    expect(text).toContain("2 clean, 1 had at least one failure");
  });

  it("lists failure sessions with their date and counts, not the full report", () => {
    const text = generateDigest([entry({ timestamp: "2026-08-15T00:00:00.000Z", fail: 3, unclear: 1, pass: 7 })], "weekly");
    expect(text).toContain("2026-08-15");
    expect(text).toContain("3 failed, 1 unclear, 7 passed");
  });

  it("does NOT list a session with zero failures under 'Sessions with failures'", () => {
    const text = generateDigest([entry({ fail: 0 })], "weekly");
    expect(text).not.toContain("Sessions with failures");
  });

  it("never includes rule text or evidence — only counts and dates (privacy check)", () => {
    // HistoryEntry has no field for rule text/evidence at all, so this is
    // structurally guaranteed, not just a string-matching accident —
    // still worth a real assertion that the output has no such content
    const text = generateDigest([entry({ fail: 1 })], "weekly");
    expect(text).not.toMatch(/evidence:|Rule \d/);
  });
});
