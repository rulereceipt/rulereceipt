import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseGeminiTranscript, geminiFormatIsKnown } from "../src/adapters/gemini.js";
import { parseSessionFile } from "../src/adapters/index.js";
import { evaluateSession } from "../src/evaluate.js";
import { loadRules } from "../src/rules.js";
import type { CheckResult, Rule, TranscriptEvent } from "../src/types.js";

/** Gemini CLI adapter — EXPERIMENTAL. SYNTHETIC fixtures pin the mapping. */
const sessionObj = (cmd: string) => ({
  sessionId: "s1",
  messages: [
    { type: "user", content: "ship it" },
    { type: "gemini", content: "ok", toolCalls: [{ name: "run_shell_command", args: { command: cmd }, status: "success", result: [{ functionResponse: { response: { output: "done" } } }] }] },
  ],
});
let _tmp: string | undefined;
function mkfile(content: string, ext = "json"): string {
  _tmp ??= mkdtempSync(join(tmpdir(), "rr-gem-"));
  const p = join(_tmp, `f${Math.random().toString(36).slice(2)}.${ext}`);
  writeFileSync(p, content);
  return p;
}

describe("parseGeminiTranscript maps Gemini messages + toolCalls", () => {
  it("maps user/gemini messages and a shell tool to a canonical Bash tool_use", () => {
    const events = parseGeminiTranscript(mkfile(JSON.stringify(sessionObj("git push origin main"))));
    expect(events.some((e) => e.kind === "text" && e.role === "user" && e.text === "ship it")).toBe(true);
    const bash = events.find((e) => e.kind === "tool_use" && e.toolName === "Bash") as Extract<TranscriptEvent, { kind: "tool_use" }> | undefined;
    expect((bash?.input as { command?: string } | undefined)?.command).toBe("git push origin main");
    expect(events.some((e) => e.kind === "tool_result")).toBe(true);
  });

  it("reads the JSONL form too", () => {
    const jsonl = sessionObj("npm test").messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
    const events = parseGeminiTranscript(mkfile(jsonl, "jsonl"));
    expect(events.some((e) => e.kind === "tool_use" && (e.input as { command?: string }).command === "npm test")).toBe(true);
  });

  it("geminiFormatIsKnown is true for Gemini, false for a Claude line", () => {
    expect(geminiFormatIsKnown(mkfile(JSON.stringify(sessionObj("ls"))))).toBe(true);
    expect(geminiFormatIsKnown(mkfile(JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n", "jsonl"))).toBe(false);
  });

  it("parseSessionFile routes a Gemini session to the Gemini reader", () => {
    const events = parseSessionFile(mkfile(JSON.stringify(sessionObj("git push origin main"))));
    expect(events.some((e) => e.kind === "tool_use" && (e.input as { command?: string }).command === "git push origin main")).toBe(true);
  });
});

describe("Gemini adapter — same engine, planted + clean", () => {
  let dir: string, home: string, prevHome: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rr-gemv-"));
    home = mkdtempSync(join(tmpdir(), "rr-gemv-home-"));
    prevHome = process.env.HOME; process.env.HOME = home; process.env.USERPROFILE = home;
    writeFileSync(join(dir, "CLAUDE.md"), "## 1. Branch\nNever push to the `main` branch directly.\n");
  });
  afterEach(() => { process.env.HOME = prevHome; rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });
  const stub = (r: Rule): CheckResult => ({ ruleId: r.id, ruleTitle: r.title, ruleSource: r.source, status: "UNCLEAR", needsHuman: true, evidence: "" });

  it("planted: a Gemini session that pushes to main is Broken", async () => {
    const f = join(dir, "s.json"); writeFileSync(f, JSON.stringify(sessionObj("git push origin main")));
    const { results } = await evaluateSession(dir, loadRules(dir), parseSessionFile(f), false, stub);
    expect(results.find((r) => /branch/i.test(r.ruleTitle))?.status).toBe("FAIL");
  });
  it("clean: only running tests is not Broken", async () => {
    const f = join(dir, "s.json"); writeFileSync(f, JSON.stringify(sessionObj("npm test")));
    const { results } = await evaluateSession(dir, loadRules(dir), parseSessionFile(f), false, stub);
    expect(results.some((r) => r.status === "FAIL")).toBe(false);
  });
});
