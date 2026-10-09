import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseClineTranscript, clineFormatIsKnown, listClineSessions, clineSessionCwd } from "../src/adapters/cline.js";
import { parseSessionFile } from "../src/adapters/index.js";
import { evaluateSession } from "../src/evaluate.js";
import { loadRules } from "../src/rules.js";
import type { CheckResult, Rule, TranscriptEvent } from "../src/types.js";

/**
 * Cline adapter — validated against a real cli v3.0.70 session (2026-10-09).
 * Builds a synthetic ~/.cline/data/sessions/<id>/ store (meta + messages).
 */
type Msg = { role: "user" | "assistant"; content: unknown[]; ts?: number };
function buildSession(root: string, id: string, cwd: string, messages: Msg[]): string {
  const dir = join(root, "data", "sessions", id);
  mkdirSync(dir, { recursive: true });
  const metaPath = join(dir, `${id}.json`);
  const msgPath = join(dir, `${id}.messages.json`);
  writeFileSync(metaPath, JSON.stringify({ version: 1, session_id: id, source: "cli", provider: "cline", model: "cline-free/mimo-v2.6-flash", cwd, workspace_root: cwd, messages_path: msgPath }));
  writeFileSync(msgPath, JSON.stringify({ version: 1, sessionId: id, origin: { source: "cli", sessionId: id }, messages: messages.map((m, i) => ({ id: `m${i}`, role: m.role, content: m.content, ts: m.ts ?? 1000 + i })) }));
  return metaPath;
}
// Canonical message parts.
const text = (t: string) => ({ type: "text", text: t });
const thinking = (t: string) => ({ type: "thinking", thinking: t });
const runCmds = (id: string, cmds: string[]) => ({ type: "tool_use", id, name: "run_commands", input: { commands: cmds } });
const runRes = (id: string, results: { result: string; success?: boolean; error?: string }[]) => ({ type: "tool_result", tool_use_id: id, name: "run_commands", content: results.map((r, k) => ({ query: `c${k}`, result: r.result, success: r.success ?? true, ...(r.error ? { error: r.error } : {}) })) });
const edit = (id: string, path: string) => ({ type: "tool_use", id, name: "editor", input: { path, old_text: "a", new_text: "a\n// c" } });
const readFiles = (id: string, files: string[]) => ({ type: "tool_use", id, name: "read_files", input: { files } });
const askQ = (id: string, question: string, options: string[]) => ({ type: "tool_use", id, name: "ask_question", input: { question, options } });
const askRes = (id: string, answer: string) => ({ type: "tool_result", tool_use_id: id, name: "ask_question", content: answer });

describe("parseClineTranscript maps the two-file store", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "rr-cline-")); });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("text, run_commands (array → one Bash each), editor → Edit; thinking skipped", () => {
    const proj = join(tmp, "proj");
    const meta = buildSession(tmp, "s1", proj, [
      { role: "user", content: [text("do it")] },
      { role: "assistant", content: [thinking("secret reasoning"), text("on it"), runCmds("t1", ["npm test", "git status"]), edit("e1", join(proj, "app.js"))] },
      { role: "user", content: [runRes("t1", [{ result: "ok" }, { result: "clean" }])] },
    ]);
    const events = parseClineTranscript(meta);
    expect(events.some((e) => e.kind === "text" && e.role === "user" && e.text === "do it")).toBe(true);
    expect(events.some((e) => e.kind === "text" && e.text === "secret reasoning")).toBe(false); // thinking ignored
    const bash = events.filter((e) => e.kind === "tool_use" && e.toolName === "Bash") as Extract<TranscriptEvent, { kind: "tool_use" }>[];
    expect(bash.map((b) => (b.input as { command: string }).command)).toEqual(["npm test", "git status"]);
    expect(events.some((e) => e.kind === "tool_use" && e.toolName === "Edit" && (e.input as { file_path?: string }).file_path === join(proj, "app.js"))).toBe(true);
  });

  it("ask_question: question → assistant text, chosen answer → USER text", () => {
    const meta = buildSession(tmp, "s2", join(tmp, "proj"), [
      { role: "assistant", content: [askQ("q1", "How should I proceed?", ["Push to main now (I authorize it)", "Don't push"])] },
      { role: "user", content: [askRes("q1", "Push to main now (I authorize it)")] },
    ]);
    const events = parseClineTranscript(meta);
    expect(events.some((e) => e.kind === "text" && e.role === "assistant" && /how should i proceed/i.test(e.text))).toBe(true);
    expect(events.some((e) => e.kind === "text" && e.role === "user" && e.text === "Push to main now (I authorize it)")).toBe(true);
  });

  it("clineFormatIsKnown true for meta and messages; clineSessionCwd reads the cwd", () => {
    const proj = join(tmp, "proj");
    const meta = buildSession(tmp, "s3", proj, [{ role: "user", content: [text("hi")] }]);
    expect(clineFormatIsKnown(meta)).toBe(true);
    expect(clineSessionCwd(meta)).toBe(proj);
    const msgPath = join(tmp, "data", "sessions", "s3", "s3.messages.json");
    expect(clineFormatIsKnown(msgPath)).toBe(true);
    const other = join(tmp, "x.json"); writeFileSync(other, JSON.stringify({ hello: "world" }));
    expect(clineFormatIsKnown(other)).toBe(false);
  });

  it("listClineSessions finds a session by cwd (via CLINE_DIR)", () => {
    const prev = process.env.CLINE_DIR;
    process.env.CLINE_DIR = tmp;
    try {
      const proj = join(tmp, "proj");
      buildSession(tmp, "s4", proj, [{ role: "user", content: [text("hi")] }]);
      buildSession(tmp, "s5", join(tmp, "other"), [{ role: "user", content: [text("hi")] }]);
      const found = listClineSessions(proj);
      expect(found.length).toBe(1);
      expect(found[0].endsWith(join("s4", "s4.json"))).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.CLINE_DIR; else process.env.CLINE_DIR = prev;
    }
  });

  it("parseSessionFile routes a Cline file to the Cline reader (not Gemini)", () => {
    const meta = buildSession(tmp, "s6", join(tmp, "proj"), [
      { role: "assistant", content: [runCmds("t1", ["git push origin main"])] },
      { role: "user", content: [runRes("t1", [{ result: "pushed" }])] },
    ]);
    const events = parseSessionFile(meta);
    expect(events.some((e) => e.kind === "tool_use" && e.toolName === "Bash" && (e.input as { command: string }).command === "git push origin main")).toBe(true);
  });
});

describe("Cline rule scoping — AGENTS.md, not CLAUDE.md / GEMINI.md", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "rr-clinescope-")); mkdirSync(join(tmp, "proj"), { recursive: true }); });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("loadRules(cwd,'cline') reads AGENTS.md and ignores CLAUDE.md / GEMINI.md", () => {
    const proj = join(tmp, "proj");
    writeFileSync(join(proj, "AGENTS.md"), "# Rules\n- Never push to main without asking me first.\n");
    writeFileSync(join(proj, "CLAUDE.md"), "# Rules\n- Claude-only sentinel rule do not load.\n");
    writeFileSync(join(proj, "GEMINI.md"), "# Rules\n- Gemini-only sentinel rule do not load.\n");
    const titles = loadRules(proj, "cline").map((r) => r.title.toLowerCase()).join(" | ");
    expect(titles).toMatch(/never push to main/);
    expect(titles).not.toMatch(/claude-only sentinel/);
    expect(titles).not.toMatch(/gemini-only sentinel/);
  });
});

describe("Cline approval gate — ask_question answer is the user's yes", () => {
  let tmp: string, home: string, prevHome: string | undefined;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "rr-clineap-"));
    home = mkdtempSync(join(tmpdir(), "rr-clineap-home-"));
    prevHome = process.env.HOME; process.env.HOME = home; process.env.USERPROFILE = home;
    mkdirSync(join(tmp, "proj"), { recursive: true });
    writeFileSync(join(tmp, "proj", "AGENTS.md"), "# Rules\n- Never push to main without asking me first.\n");
  });
  afterEach(() => { process.env.HOME = prevHome; rmSync(tmp, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });
  const stub = (r: Rule): CheckResult => ({ ruleId: r.id, ruleTitle: r.title, ruleSource: r.source, status: "UNCLEAR", needsHuman: true, evidence: "" });
  const pushVerdict = async (meta: string, proj: string) => {
    const { results } = await evaluateSession(proj, loadRules(proj, "cline"), parseClineTranscript(meta), false, stub);
    return results.find((r) => /push to main/i.test(r.ruleTitle))?.status;
  };

  // The prompt deliberately does NOT contain a push keyword, so the ONLY thing
  // that can approve the push is the ask_question answer — isolating that mapping.
  it("APPROVED: ask_question answered 'Push to main…' before the push → Followed (PASS)", async () => {
    const proj = join(tmp, "proj");
    const meta = buildSession(tmp, "ap1", proj, [
      { role: "user", content: [text("add a comment to app.js and get the repo up to date")] },
      { role: "assistant", content: [askQ("q1", "AGENTS.md says ask before pushing to main. How should I proceed?", ["Push to main now (I authorize it)", "Don't push"])] },
      { role: "user", content: [askRes("q1", "Push to main now (I authorize it)")] },
      { role: "assistant", content: [runCmds("t1", ["git push origin main"])] },
      { role: "user", content: [runRes("t1", [{ result: "pushed" }])] },
    ]);
    expect(await pushVerdict(meta, proj)).toBe("PASS");
  });

  // Same session WITHOUT the ask_question exchange: nothing approves the push, so
  // it is NOT Followed (proves the PASS above comes from the answer, not elsewhere).
  it("NO ASK: a push with nothing approving it is NOT Followed (red control)", async () => {
    const proj = join(tmp, "proj");
    const meta = buildSession(tmp, "ap2", proj, [
      { role: "user", content: [text("add a comment to app.js and get the repo up to date")] },
      { role: "assistant", content: [runCmds("t1", ["git push origin main"])] },
      { role: "user", content: [runRes("t1", [{ result: "pushed" }])] },
    ]);
    expect(await pushVerdict(meta, proj)).not.toBe("PASS");
  });

  it("CLEAN: only reading .env (cat) is not a mutation → no FAIL", async () => {
    const proj = join(tmp, "proj");
    writeFileSync(join(proj, "AGENTS.md"), "# Rules\n- Never edit .env.\n");
    const meta = buildSession(tmp, "ap3", proj, [
      { role: "assistant", content: [readFiles("r1", [join(proj, ".env")]), runCmds("t1", ["cat .env"])] },
      { role: "user", content: [runRes("t1", [{ result: "SECRET=fake" }])] },
    ]);
    const { results } = await evaluateSession(proj, loadRules(proj, "cline"), parseClineTranscript(meta), false, stub);
    expect(results.some((r) => r.status === "FAIL")).toBe(false);
  });
});
