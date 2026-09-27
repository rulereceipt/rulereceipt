import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { parseCodexLine, parseCodexTranscript, listCodexSessions } from "../src/adapters/codex.js";
import { findLatestSession } from "../src/adapters/index.js";

const homeState = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => homeState.current || actual.homedir() };
});

/**
 * Codex CLI adapter. Format verified against the openai/codex repo + a real
 * v0.130.0 rollout dump (2026-09-26), parsed tolerantly because OpenAI ships
 * no stable schema. These fixtures use the verified line shapes.
 */
const line = (o: unknown) => JSON.stringify(o);
const responseItem = (payload: unknown, timestamp = "2026-03-31T22:18:46Z") =>
  line({ timestamp, type: "response_item", payload });

describe("parseCodexLine maps the verified response_item shapes", () => {
  it("maps a user message to a text event", () => {
    const [e] = parseCodexLine(responseItem({ type: "message", role: "user", content: [{ type: "input_text", text: "fix the bug" }] }));
    expect(e).toMatchObject({ kind: "text", role: "user", text: "fix the bug" });
  });

  it("maps an assistant message to a text event", () => {
    const [e] = parseCodexLine(responseItem({ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }));
    expect(e).toMatchObject({ kind: "text", role: "assistant", text: "done" });
  });

  it("maps a function_call to a tool_use with parsed input and call id", () => {
    const [e] = parseCodexLine(responseItem({ type: "function_call", name: "exec_command", arguments: '{"command":"npm test"}', call_id: "call_1" }));
    expect(e).toMatchObject({ kind: "tool_use", role: "assistant", toolName: "exec_command", toolUseId: "call_1" });
    expect((e as { input: { command: string } }).input.command).toBe("npm test");
  });

  it("maps a local_shell_call to a tool_use", () => {
    const [e] = parseCodexLine(responseItem({ type: "local_shell_call", action: { command: ["bash", "-lc", "ls"] }, call_id: "c2" }));
    expect(e).toMatchObject({ kind: "tool_use", role: "assistant", toolName: "shell" });
  });

  it("maps a function_call_output to a tool_result paired by call id", () => {
    const [e] = parseCodexLine(responseItem({ type: "function_call_output", call_id: "call_1", output: "1 passed" }));
    expect(e).toMatchObject({ kind: "tool_result", role: "user", content: "1 passed", toolUseId: "call_1", isError: false });
  });

  it("reads a nonzero exit code as an error result", () => {
    const [e] = parseCodexLine(responseItem({ type: "function_call_output", call_id: "c", output: { output: "boom", exit_code: 1 } }));
    expect(e).toMatchObject({ kind: "tool_result", isError: true });
  });

  // Fail-closed: none of these may fabricate an event.
  it("ignores a session_meta line (no event fabricated)", () => {
    expect(parseCodexLine(line({ timestamp: "t", type: "session_meta", payload: { id: "x", cwd: "/p" } }))).toEqual([]);
  });
  it("ignores an unknown response_item payload type (e.g. reasoning)", () => {
    expect(parseCodexLine(responseItem({ type: "reasoning", summary: [] }))).toEqual([]);
  });
  it("ignores event_msg / turn_context lines", () => {
    expect(parseCodexLine(line({ type: "event_msg", payload: { type: "agent_message" } }))).toEqual([]);
  });
  it("returns [] on malformed JSON rather than throwing", () => {
    expect(parseCodexLine("{not json")).toEqual([]);
  });
});

describe("listCodexSessions filters a global store to one project by session_meta.cwd", () => {
  let home: string;
  let projectA: string;
  let projectB: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "rr-codex-home-"));
    projectA = "/work/projectA";
    projectB = "/work/projectB";
    homeState.current = home;

    const day = join(home, ".codex", "sessions", "2026", "03", "31");
    mkdirSync(day, { recursive: true });
    const meta = (cwd: string) => line({ timestamp: "t", type: "session_meta", payload: { id: "1", cwd } });
    const msg = responseItem({ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] });
    writeFileSync(join(day, "rollout-A.jsonl"), meta(projectA) + "\n" + msg + "\n");
    writeFileSync(join(day, "rollout-B.jsonl"), meta(projectB) + "\n" + msg + "\n");
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    homeState.current = "";
  });

  it("returns only the session whose recorded cwd matches", () => {
    const forA = listCodexSessions(projectA);
    expect(forA).toHaveLength(1);
    expect(forA[0].endsWith("rollout-A.jsonl")).toBe(true);
    expect(listCodexSessions("/work/nowhere")).toEqual([]);
  });

  it("parseCodexTranscript reads the whole rollout file", () => {
    const forA = listCodexSessions(projectA);
    const events = parseCodexTranscript(forA[0]);
    expect(events.some((e) => e.kind === "text" && e.text === "hi")).toBe(true);
  });

  it("findLatestSession selects the Codex session when it is the only tool present", () => {
    const latest = findLatestSession(projectA);
    expect(latest?.adapter.tool).toBe("codex");
  });
});
