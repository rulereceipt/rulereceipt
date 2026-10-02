import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCursorTranscript, cursorFormatIsKnown } from "../src/adapters/cursor.js";
import { parseSessionFile } from "../src/adapters/index.js";
import { evaluateSession } from "../src/evaluate.js";
import { loadRules } from "../src/rules.js";
import type { CheckResult, Rule, TranscriptEvent } from "../src/types.js";

/** Cursor adapter — EXPERIMENTAL. SYNTHETIC agent-transcript (Anthropic blocks). */
const line = (o: unknown) => JSON.stringify(o);
const session = (cmd: string) =>
  [
    line({ role: "user", content: [{ type: "text", text: "ship it" }] }),
    line({ role: "assistant", content: [{ type: "text", text: "ok" }, { type: "tool_use", id: "t1", name: "Bash", input: { command: cmd } }] }),
    line({ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "done", is_error: false }] }),
  ].join("\n") + "\n";
let _tmp: string | undefined;
function mkfile(content: string): string {
  _tmp ??= mkdtempSync(join(tmpdir(), "rr-cur-"));
  const p = join(_tmp, `f${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(p, content);
  return p;
}

describe("parseCursorTranscript maps Anthropic-block agent-transcripts", () => {
  it("maps text + a shell tool_use to canonical Bash, and a tool_result", () => {
    const events = parseCursorTranscript(mkfile(session("git push origin main")));
    expect(events.some((e) => e.kind === "text" && e.role === "user" && e.text === "ship it")).toBe(true);
    const bash = events.find((e) => e.kind === "tool_use" && e.toolName === "Bash") as Extract<TranscriptEvent, { kind: "tool_use" }> | undefined;
    expect((bash?.input as { command?: string } | undefined)?.command).toBe("git push origin main");
    expect(events.some((e) => e.kind === "tool_result")).toBe(true);
  });

  it("cursorFormatIsKnown true for a Cursor line, false for a Claude line", () => {
    expect(cursorFormatIsKnown(mkfile(session("ls")))).toBe(true);
    expect(cursorFormatIsKnown(mkfile(line({ type: "user", message: { role: "user", content: [] } }) + "\n"))).toBe(false);
  });

  it("parseSessionFile routes a Cursor transcript to the Cursor reader", () => {
    const events = parseSessionFile(mkfile(session("git push origin main")));
    expect(events.some((e) => e.kind === "tool_use" && (e.input as { command?: string }).command === "git push origin main")).toBe(true);
  });
});

describe("Cursor adapter — same engine, planted + clean", () => {
  let dir: string, home: string, prevHome: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rr-curv-"));
    home = mkdtempSync(join(tmpdir(), "rr-curv-home-"));
    prevHome = process.env.HOME; process.env.HOME = home; process.env.USERPROFILE = home;
    writeFileSync(join(dir, "CLAUDE.md"), "## 1. Branch\nNever push to the `main` branch directly.\n");
  });
  afterEach(() => { process.env.HOME = prevHome; rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });
  const stub = (r: Rule): CheckResult => ({ ruleId: r.id, ruleTitle: r.title, ruleSource: r.source, status: "UNCLEAR", needsHuman: true, evidence: "" });

  it("planted: a Cursor session that pushes to main is Broken", async () => {
    const f = join(dir, "t.jsonl"); writeFileSync(f, session("git push origin main"));
    const { results } = await evaluateSession(dir, loadRules(dir), parseSessionFile(f), false, stub);
    expect(results.find((r) => /branch/i.test(r.ruleTitle))?.status).toBe("FAIL");
  });
  it("clean: only running tests is not Broken", async () => {
    const f = join(dir, "t.jsonl"); writeFileSync(f, session("npm test"));
    const { results } = await evaluateSession(dir, loadRules(dir), parseSessionFile(f), false, stub);
    expect(results.some((r) => r.status === "FAIL")).toBe(false);
  });
});
