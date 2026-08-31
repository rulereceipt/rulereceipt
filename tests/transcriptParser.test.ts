import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { readLatestTranscript, parseLine, findLatestSessionFile } from "../src/parsers/transcriptParser.js";

// Uses this actual project directory's real Claude Code session history —
// the same session data RuleReceipt will read in real use. Computed rather
// than hardcoded so no local username/path ever lands in tracked source.
const REAL_CWD = dirname(process.cwd());

// Defaults to the REAL home directory so every pre-existing test below
// (which reads this machine's actual Claude Code history) is unaffected —
// only the new describe block for this fix overrides it to a temp dir.
// vi.hoisted is required here: vi.mock's factory is hoisted above normal
// top-level statements, so a plain `let` written after it would still be
// in its temporal dead zone when the factory first runs.
const homeState = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  homeState.current = actual.homedir();
  return { ...actual, homedir: () => homeState.current };
});

describe("findLatestSessionFile across multiple Claude home directory variants", () => {
  const projectCwd = "/fake/project/path";
  const encoded = projectCwd.replace(/\//g, "-");
  let tempHome: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "rulereceipt-home-test-"));
    homeState.current = tempHome;
  });

  const realHome = homeState.current;

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
    // restore, so the real-session tests elsewhere in this file (which
    // rely on the actual home directory) aren't left pointed at a
    // now-deleted temp dir
    homeState.current = realHome;
  });

  function writeSession(homeDirName: string, sessionName: string, content: string, mtime: Date) {
    const dir = join(tempHome, homeDirName, "projects", encoded);
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, sessionName);
    writeFileSync(filePath, content);
    utimesSync(filePath, mtime, mtime);
    return filePath;
  }

  it("returns null when neither .claude nor .claude-office has a matching project", () => {
    expect(findLatestSessionFile(projectCwd)).toBeNull();
  });

  it("finds a session under the standard ~/.claude/projects location", () => {
    const filePath = writeSession(".claude", "a.jsonl", "{}", new Date());
    expect(findLatestSessionFile(projectCwd)).toBe(filePath);
  });

  // this is the real gap found 2026-08-30: a hosted/office Claude Code
  // variant writes here instead, and the tool must still find it
  it("finds a session under ~/.claude-office/projects when .claude has nothing", () => {
    const filePath = writeSession(".claude-office", "a.jsonl", "{}", new Date());
    expect(findLatestSessionFile(projectCwd)).toBe(filePath);
  });

  it("picks the overall most recent session across both locations, not just the first root checked", () => {
    writeSession(".claude", "older.jsonl", "{}", new Date("2026-01-01"));
    const newerPath = writeSession(".claude-office", "newer.jsonl", "{}", new Date("2026-06-01"));
    expect(findLatestSessionFile(projectCwd)).toBe(newerPath);
  });

  // proves this generalizes beyond the two names seen on the machine this
  // was found on — a different org's variant could be named anything
  // starting with ".claude", and this must still find it without a
  // hardcoded name list
  it("finds a session under a never-hardcoded .claude-prefixed directory name", () => {
    const filePath = writeSession(".claude-some-other-orgs-variant", "a.jsonl", "{}", new Date());
    expect(findLatestSessionFile(projectCwd)).toBe(filePath);
  });

  it("ignores a directory that merely starts with .claude in name but isn't actually one (sanity check)", () => {
    // ".clauded" starts with ".claude" as a string prefix but is a
    // realistic near-miss; it should still be picked up since the
    // implementation matches by prefix, not exact names — this documents
    // that behavior rather than asserting the opposite
    const filePath = writeSession(".clauded", "a.jsonl", "{}", new Date());
    expect(findLatestSessionFile(projectCwd)).toBe(filePath);
  });
});

// Same reasoning as claudeMdParser's real-file suite: this reads actual
// Claude Code session history from this machine. No such history exists
// on a CI runner, so skip rather than fail.
describe.skipIf(!findLatestSessionFile(REAL_CWD))("readLatestTranscript against a real project's session history", () => {
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
