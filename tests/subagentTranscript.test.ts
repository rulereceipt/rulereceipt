import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { findSubagentFiles, readLatestTranscript, subagentNote } from "../src/parsers/transcriptParser.js";

const homeState = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  homeState.current = actual.homedir();
  return { ...actual, homedir: () => homeState.current };
});

/**
 * Subagents write their own JSONL under a directory named after the parent
 * session id (verified against real files 2026-09-23). The reader used to
 * take only the newest top-level file, so a rule broken inside a subagent was
 * never checked. This proves subagent events are now pulled in.
 */
const assistantToolUse = (command: string, id = "t1") =>
  JSON.stringify({
    type: "assistant",
    timestamp: "2026-09-23T00:00:00Z",
    message: { content: [{ type: "tool_use", name: "Bash", id, input: { command } }] },
  });

describe("findSubagentFiles", () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "rr-sub-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("finds subagent files in <sessionId>/subagents next to the session file", () => {
    const sessionFile = join(dir, "SID.jsonl");
    writeFileSync(sessionFile, assistantToolUse("git status"));
    mkdirSync(join(dir, "SID", "subagents"), { recursive: true });
    writeFileSync(join(dir, "SID", "subagents", "agent-x.jsonl"), assistantToolUse("git push --force"));
    const found = findSubagentFiles(sessionFile);
    expect(found).toHaveLength(1);
    expect(found[0]).toBe(join(dir, "SID", "subagents", "agent-x.jsonl"));
  });

  it("returns nothing when there is no subagents directory", () => {
    const sessionFile = join(dir, "SID.jsonl");
    writeFileSync(sessionFile, assistantToolUse("git status"));
    expect(findSubagentFiles(sessionFile)).toHaveLength(0);
  });

  it("subagentNote reports the count, or null when there are none", () => {
    const sessionFile = join(dir, "SID.jsonl");
    writeFileSync(sessionFile, assistantToolUse("git status"));
    expect(subagentNote(sessionFile)).toBeNull();
    expect(subagentNote(null)).toBeNull();
    mkdirSync(join(dir, "SID", "subagents"), { recursive: true });
    writeFileSync(join(dir, "SID", "subagents", "agent-x.jsonl"), assistantToolUse("git push"));
    expect(subagentNote(sessionFile)).toMatch(/Checked 1 subagent session /);
  });
});

describe("readLatestTranscript includes subagent events", () => {
  let tempHome: string;
  const realHome = homeState.current;
  const cwd = "/Users/x/proj";
  const enc = cwd.replace(/\//g, "-");
  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "rr-sub-home-"));
    homeState.current = tempHome;
    const projectDir = join(tempHome, ".claude", "projects", enc);
    mkdirSync(join(projectDir, "SID", "subagents"), { recursive: true });
    writeFileSync(join(projectDir, "SID.jsonl"), assistantToolUse("git status", "main1"));
    writeFileSync(join(projectDir, "SID", "subagents", "agent-a.jsonl"), assistantToolUse("git push --force", "sub1"));
  });
  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
    homeState.current = realHome;
  });

  it("pulls a subagent's tool call into the checked stream", () => {
    const events = readLatestTranscript(cwd);
    const commands = events
      .filter((e): e is Extract<typeof e, { kind: "tool_use" }> => e.kind === "tool_use")
      .map((e) => (e.input as { command?: string }).command);
    expect(commands).toContain("git status"); // main
    expect(commands).toContain("git push --force"); // subagent — previously invisible
  });
});
