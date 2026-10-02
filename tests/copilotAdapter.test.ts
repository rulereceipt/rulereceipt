import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCopilotTranscript, copilotFormatIsKnown } from "../src/adapters/copilot.js";
import { parseSessionFile } from "../src/adapters/index.js";
import { evaluateSession } from "../src/evaluate.js";
import { loadRules } from "../src/rules.js";
import type { CheckResult, Rule, TranscriptEvent } from "../src/types.js";

/**
 * Copilot CLI adapter — EXPERIMENTAL. These are SYNTHETIC fixtures (no real
 * Copilot session yet): they pin the mapping of the documented event shapes to
 * our neutral events and prove a planted break is caught / a clean run is quiet
 * through the SAME engine. "supported" waits on real sample sessions.
 */
const line = (o: unknown) => JSON.stringify(o);
const session = (shellCmd: string) =>
  [
    line({ type: "session.start", timestamp: "2026-10-02T10:00:00Z", data: { selectedModel: "gpt-5" } }),
    line({ type: "user.message", timestamp: "2026-10-02T10:00:01Z", data: { content: "ship it" } }),
    line({ type: "assistant.message", timestamp: "2026-10-02T10:00:02Z", data: { content: "on it", toolRequests: [{ name: "shell", arguments: { command: shellCmd } }] } }),
    line({ type: "tool.execution_start", timestamp: "2026-10-02T10:00:03Z", data: { toolName: "shell", toolCallId: "c1", arguments: { command: shellCmd } } }),
    line({ type: "tool.execution_complete", timestamp: "2026-10-02T10:00:04Z", data: { toolCallId: "c1", success: true, result: "ok" } }),
  ].join("\n") + "\n";

describe("parseCopilotTranscript maps the documented Copilot event shapes", () => {
  it("maps user/assistant messages and a shell tool to a canonical Bash tool_use", () => {
    const events = parseCopilotTranscript(mkfile(session("git push origin main")));
    expect(events.some((e) => e.kind === "text" && e.role === "user" && e.text === "ship it")).toBe(true);
    expect(events.some((e) => e.kind === "text" && e.role === "assistant")).toBe(true);
    const bash = events.find((e) => e.kind === "tool_use" && e.toolName === "Bash") as Extract<TranscriptEvent, { kind: "tool_use" }> | undefined;
    expect((bash?.input as { command?: string } | undefined)?.command).toBe("git push origin main");
    expect(events.some((e) => e.kind === "tool_result")).toBe(true);
  });

  it("copilotFormatIsKnown is true for a Copilot log, false otherwise", () => {
    expect(copilotFormatIsKnown(mkfile(session("npm test")))).toBe(true);
    expect(copilotFormatIsKnown(mkfile(line({ type: "assistant", message: { content: [] } }) + "\n"))).toBe(false);
  });

  it("unknown event types and bad lines are skipped, never fabricated", () => {
    const f = mkfile([line({ type: "user.message", data: { content: "hi" } }), "{not json", line({ type: "future.event.v9", data: { x: 1 } })].join("\n") + "\n");
    const events = parseCopilotTranscript(f);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "text", role: "user", text: "hi" });
  });

  it("parseSessionFile routes a Copilot events.jsonl to the Copilot reader", () => {
    const events = parseSessionFile(mkfile(session("git push origin main")));
    expect(events.some((e) => e.kind === "tool_use" && (e.input as { command?: string }).command === "git push origin main")).toBe(true);
  });
});

describe("Copilot adapter — same engine catches a planted break, stays quiet on a clean run", () => {
  let dir: string, home: string, prevHome: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rr-cop-"));
    home = mkdtempSync(join(tmpdir(), "rr-cop-home-"));
    prevHome = process.env.HOME; process.env.HOME = home; process.env.USERPROFILE = home;
    writeFileSync(join(dir, "CLAUDE.md"), "## 1. Branch\nNever push to the `main` branch directly.\n");
  });
  afterEach(() => { process.env.HOME = prevHome; rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });
  const stub = (r: Rule): CheckResult => ({ ruleId: r.id, ruleTitle: r.title, ruleSource: r.source, status: "UNCLEAR", needsHuman: true, evidence: "" });

  it("planted: a Copilot session that pushes to main is Broken", async () => {
    const f = join(dir, "events.jsonl"); writeFileSync(f, session("git push origin main"));
    const { results } = await evaluateSession(dir, loadRules(dir), parseSessionFile(f), false, stub);
    expect(results.find((r) => /branch/i.test(r.ruleTitle))?.status).toBe("FAIL");
  });
  it("clean: a Copilot session that only runs tests is not Broken", async () => {
    const f = join(dir, "events.jsonl"); writeFileSync(f, session("npm test"));
    const { results } = await evaluateSession(dir, loadRules(dir), parseSessionFile(f), false, stub);
    expect(results.some((r) => r.status === "FAIL")).toBe(false);
  });
});

let _tmp: string | undefined;
function mkfile(content: string): string {
  _tmp ??= mkdtempSync(join(tmpdir(), "rr-cop-files-"));
  const p = join(_tmp, `f${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(p, content);
  return p;
}
