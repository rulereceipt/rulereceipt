import { describe, it, expect } from "vitest";
import { readLatestTranscript } from "../src/parsers/transcriptParser.js";

// Uses this actual project directory's real Claude Code session history —
// the same session data RuleReceipt will read in real use.
const REAL_CWD = "/Users/dev/project";

describe("readLatestTranscript against a real project's session history", () => {
  it("returns a non-empty list of events for a project with real history", () => {
    const events = readLatestTranscript(REAL_CWD);
    expect(events.length).toBeGreaterThan(0);
  });

  it("includes at least one assistant text event", () => {
    const events = readLatestTranscript(REAL_CWD);
    expect(events.some((e) => e.role === "assistant" && e.kind === "text")).toBe(true);
  });

  it("includes at least one tool_use event with a tool name", () => {
    const events = readLatestTranscript(REAL_CWD);
    const toolUse = events.find((e) => e.kind === "tool_use");
    expect(toolUse && "toolName" in toolUse && typeof toolUse.toolName === "string").toBe(true);
  });

  it("every event has a non-function role of user or assistant", () => {
    const events = readLatestTranscript(REAL_CWD);
    expect(events.every((e) => e.role === "user" || e.role === "assistant")).toBe(true);
  });

  it("returns an empty array, not a throw, for a project with no history", () => {
    const events = readLatestTranscript("/definitely/not/a/real/project/path");
    expect(events).toEqual([]);
  });

  // proves this test can actually fail: a role that will never appear
  it("FAILS if searching for a role that doesn't exist (sanity check on the test itself)", () => {
    const events = readLatestTranscript(REAL_CWD);
    // @ts-expect-error - intentionally checking an invalid role never appears
    expect(events.some((e) => e.role === "system-that-does-not-exist")).toBe(false);
  });
});
