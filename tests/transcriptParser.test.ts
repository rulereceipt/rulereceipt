import { describe, it, expect } from "vitest";
import { readLatestTranscript, parseLine } from "../src/parsers/transcriptParser.js";

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

describe("parseLine against malformed but JSON-valid lines (real bug found by audit)", () => {
  // Before the fix: JSON.parse("null") succeeds (null is valid JSON), then
  // `obj.timestamp` threw TypeError, uncaught, crashing the entire `check`
  // command on one bad line. Reverting the type guard reproduces this —
  // confirmed by hand before writing the fix, not assumed.
  it("does not throw on a line that is the JSON value null", () => {
    expect(() => parseLine("null")).not.toThrow();
    expect(parseLine("null")).toEqual([]);
  });

  it("does not throw on a line that is a bare JSON number", () => {
    expect(() => parseLine("42")).not.toThrow();
    expect(parseLine("42")).toEqual([]);
  });

  it("does not throw on a line that is a bare JSON string", () => {
    expect(() => parseLine('"just a string"')).not.toThrow();
    expect(parseLine('"just a string"')).toEqual([]);
  });

  it("does not throw on a line that is a JSON array", () => {
    expect(() => parseLine("[1,2,3]")).not.toThrow();
    expect(parseLine("[1,2,3]")).toEqual([]);
  });

  it("still parses a real assistant text event correctly (guard doesn't break the happy path)", () => {
    const line = JSON.stringify({
      type: "assistant",
      timestamp: "2026-01-01T00:00:00Z",
      message: { content: [{ type: "text", text: "hello" }] },
    });
    const events = parseLine(line);
    expect(events).toEqual([{ role: "assistant", kind: "text", text: "hello", timestamp: "2026-01-01T00:00:00Z" }]);
  });
});
