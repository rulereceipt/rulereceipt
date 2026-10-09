import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { parseDevinTranscript, devinFormatIsKnown, listDevinSessions, devinSessionCwd, isDevinHandle } from "../src/adapters/devin.js";
import { parseSessionFile } from "../src/adapters/index.js";
import { evaluateSession } from "../src/evaluate.js";
import { loadRules } from "../src/rules.js";
import type { CheckResult, Rule, TranscriptEvent } from "../src/types.js";

/**
 * Devin Desktop adapter — validated against a real session (`showy-attention`,
 * backend windsurf, model swe-1-6-slow, Devin Desktop 3.10.48, 2026-10-09).
 * These build a real temp sessions.db in the schema the reader expects. The
 * store is ONE db for all sessions (addressed by a `<db>#<id>` handle), and the
 * transcript is a FOREST — a retry forks the graph, so a planted abandoned
 * branch proves the main-chain walk dedupes it. Skipped where node:sqlite is
 * absent (Node < 22.5), the same degradation the reader does.
 */
let DatabaseSync: (new (p: string) => { exec(s: string): void; prepare(s: string): { run(...a: unknown[]): void }; close(): void }) | undefined;
try { DatabaseSync = createRequire(import.meta.url)("node:sqlite").DatabaseSync; } catch { /* older Node */ }
const sqliteDescribe = DatabaseSync ? describe : describe.skip;

type Node = { node_id: number; parent: number | null; msg: unknown };
function buildDb(dbPath: string, opts: { cwd: string; mainChainId: number; nodes: Node[]; hidden?: boolean }): void {
  mkdirSync(join(dbPath, ".."), { recursive: true });
  const db = new DatabaseSync!(dbPath);
  db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, working_directory TEXT, backend_type TEXT, model TEXT, agent_mode TEXT, created_at INTEGER, last_activity_at INTEGER, title TEXT, main_chain_id INTEGER, hidden INTEGER DEFAULT 0)");
  db.exec("CREATE TABLE message_nodes (row_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, node_id INTEGER, parent_node_id INTEGER, chat_message TEXT, created_at INTEGER, metadata TEXT)");
  db.prepare("INSERT INTO sessions (id, working_directory, backend_type, model, agent_mode, created_at, last_activity_at, title, main_chain_id, hidden) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run("sess1", opts.cwd, "windsurf", "swe-1-6-slow", "accept-edits", 1000, 2000, "do the thing", opts.mainChainId, opts.hidden ? 1 : 0);
  const ins = db.prepare("INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at) VALUES (?,?,?,?,?)");
  for (const n of opts.nodes) ins.run("sess1", n.node_id, n.parent, JSON.stringify(n.msg), 1000 + n.node_id);
  db.close();
}

// Canonical chat_message shapes.
const sys = (text: string) => ({ role: "system", content: text });
const user = (text: string | unknown[]) => ({ role: "user", content: text });
const asst = (content: string, tool_calls: unknown[] = [], thinking?: string) =>
  ({ role: "assistant", content, tool_calls, ...(thinking ? { thinking: { thinking, signature: "" } } : {}) });
const call = (id: string, name: string, args: Record<string, unknown>) => ({ id, name, arguments: args, index: 0, kind: "function" });
const tool = (id: string, content: string, success = true) =>
  ({ role: "tool", content, tool_call_id: id, metadata: { extensions: { "chisel/tool_result_meta": { success, kind: "exec" } } } });

sqliteDescribe("parseDevinTranscript walks the main chain and maps tool calls", () => {
  let tmp = "";
  const dbPathOf = (base: string) => join(base, "cli", "sessions.db");
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "rr-devin-")); });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("maps system(skip)/user/assistant(text+tool_calls)/tool, ignores thinking", () => {
    const cwd = join(tmp, "proj");
    buildDb(dbPathOf(tmp), {
      cwd, mainChainId: 5, nodes: [
        { node_id: 0, parent: null, msg: sys("<rules>…</rules>") },
        { node_id: 1, parent: 0, msg: user("add a comment to app.js") },
        { node_id: 2, parent: 1, msg: asst("", [call("c1", "read", { file_path: join(cwd, "app.js") })], "secret reasoning") },
        { node_id: 3, parent: 2, msg: tool("c1", "console.log(\"hi\")") },
        { node_id: 4, parent: 3, msg: asst("", [call("c2", "edit", { file_path: join(cwd, "app.js"), old_string: "a", new_string: "a\n// c" }), call("c3", "exec", { command: "git status" })]) },
        { node_id: 5, parent: 4, msg: asst("DONE.") },
      ],
    });
    const events = parseDevinTranscript(`${dbPathOf(tmp)}#sess1`);
    expect(events.some((e) => e.kind === "text" && e.role === "user" && e.text === "add a comment to app.js")).toBe(true);
    expect(events.some((e) => e.kind === "text" && /secret reasoning/.test(e.text))).toBe(false); // thinking ignored
    expect(events.some((e) => e.kind === "text" && e.role === "system")).toBe(false); // system skipped
    expect(events.some((e) => e.kind === "tool_use" && e.toolName === "Read")).toBe(true);
    expect(events.some((e) => e.kind === "tool_use" && e.toolName === "Edit" && (e.input as { file_path?: string }).file_path === join(cwd, "app.js"))).toBe(true);
    expect(events.some((e) => e.kind === "tool_use" && e.toolName === "Bash" && (e.input as { command?: string }).command === "git status")).toBe(true);
    expect(events.some((e) => e.kind === "text" && e.role === "assistant" && e.text === "DONE.")).toBe(true);
  });

  it("dedupes retry branches: an abandoned sibling off the main chain is NOT emitted", () => {
    const cwd = join(tmp, "proj");
    buildDb(dbPathOf(tmp), {
      cwd, mainChainId: 4, nodes: [
        { node_id: 0, parent: null, msg: sys("preamble") },
        { node_id: 1, parent: 0, msg: user("get the repo up to date") },
        // node 2 is an ABANDONED retry (an edit to secret.txt) — a child of 1 but
        // NOT on the chain from the main_chain_id head (4).
        { node_id: 2, parent: 1, msg: asst("", [call("bad", "edit", { file_path: join(cwd, "secret.txt"), old_string: "x", new_string: "y" })]) },
        // node 3 is the branch the user actually saw.
        { node_id: 3, parent: 1, msg: asst("", [call("c1", "exec", { command: "git push origin main" })]) },
        { node_id: 4, parent: 3, msg: tool("c1", "pushed") },
      ],
    });
    const events = parseDevinTranscript(`${dbPathOf(tmp)}#sess1`);
    expect(events.some((e) => e.kind === "tool_use" && e.toolName === "Bash" && (e.input as { command?: string }).command === "git push origin main")).toBe(true);
    // The abandoned branch's edit must not appear.
    expect(events.some((e) => e.kind === "tool_use" && (e.input as { file_path?: string }).file_path === join(cwd, "secret.txt"))).toBe(false);
  });

  it("content as an array of parts is read as text; tool error flag is honored", () => {
    const cwd = join(tmp, "proj");
    buildDb(dbPathOf(tmp), {
      cwd, mainChainId: 2, nodes: [
        { node_id: 0, parent: null, msg: user([{ type: "text", text: "run it" }]) },
        { node_id: 1, parent: 0, msg: asst("", [call("c1", "exec", { command: "false" })]) },
        { node_id: 2, parent: 1, msg: tool("c1", "boom", false) },
      ],
    });
    const events = parseDevinTranscript(`${dbPathOf(tmp)}#sess1`);
    expect(events.some((e) => e.kind === "text" && e.role === "user" && e.text === "run it")).toBe(true);
    const res = events.find((e) => e.kind === "tool_result") as Extract<TranscriptEvent, { kind: "tool_result" }> | undefined;
    expect(res?.isError).toBe(true);
  });

  it("devinFormatIsKnown / isDevinHandle / devinSessionCwd", () => {
    const cwd = join(tmp, "proj");
    buildDb(dbPathOf(tmp), { cwd, mainChainId: 0, nodes: [{ node_id: 0, parent: null, msg: user("hi") }] });
    const handle = `${dbPathOf(tmp)}#sess1`;
    expect(isDevinHandle(handle)).toBe(true);
    expect(isDevinHandle("/some/plain/file.json")).toBe(false);
    expect(devinFormatIsKnown(handle)).toBe(true);
    expect(devinFormatIsKnown(`${dbPathOf(tmp)}#no-such-session`)).toBe(false);
    expect(devinSessionCwd(handle)).toBe(cwd);
  });

  it("listDevinSessions finds a session by cwd (via DEVIN_DIR), skips hidden", () => {
    const prev = process.env.DEVIN_DIR;
    process.env.DEVIN_DIR = join(tmp, "cli");
    try {
      const cwd = join(tmp, "proj");
      buildDb(dbPathOf(tmp), { cwd, mainChainId: 0, nodes: [{ node_id: 0, parent: null, msg: user("hi") }] });
      expect(listDevinSessions(cwd)).toEqual([`${dbPathOf(tmp)}#sess1`]);
      expect(listDevinSessions(join(tmp, "elsewhere"))).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.DEVIN_DIR; else process.env.DEVIN_DIR = prev;
    }
  });

  it("hidden sessions are not listed", () => {
    const prev = process.env.DEVIN_DIR;
    process.env.DEVIN_DIR = join(tmp, "cli");
    try {
      const cwd = join(tmp, "proj");
      buildDb(dbPathOf(tmp), { cwd, mainChainId: 0, hidden: true, nodes: [{ node_id: 0, parent: null, msg: user("hi") }] });
      expect(listDevinSessions(cwd)).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.DEVIN_DIR; else process.env.DEVIN_DIR = prev;
    }
  });

  it("parseSessionFile routes a Devin handle (not a real file) to the reader", () => {
    const cwd = join(tmp, "proj");
    buildDb(dbPathOf(tmp), {
      cwd, mainChainId: 1, nodes: [
        { node_id: 0, parent: null, msg: user("ship it") },
        { node_id: 1, parent: 0, msg: asst("", [call("c1", "exec", { command: "git push origin main" })]) },
      ],
    });
    const events = parseSessionFile(`${dbPathOf(tmp)}#sess1`);
    expect(events.some((e) => e.kind === "tool_use" && (e.input as { command?: string }).command === "git push origin main")).toBe(true);
  });
});

describe("Devin rule scoping — AGENTS.md + CLAUDE.md, not GEMINI.md", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "rr-devinscope-")); mkdirSync(join(tmp, "proj"), { recursive: true }); });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("loadRules(cwd,'devin') reads AGENTS.md and CLAUDE.md, ignores GEMINI.md", () => {
    const proj = join(tmp, "proj");
    writeFileSync(join(proj, "AGENTS.md"), "# Rules\n- Never push to main without asking me first.\n");
    writeFileSync(join(proj, "CLAUDE.md"), "# Rules\n- Never edit the secrets file.\n");
    writeFileSync(join(proj, "GEMINI.md"), "# Rules\n- Gemini-only sentinel rule do not load.\n");
    const titles = loadRules(proj, "devin").map((r) => r.title.toLowerCase()).join(" | ");
    expect(titles).toMatch(/never push to main/);
    expect(titles).toMatch(/never edit the secrets file/);
    expect(titles).not.toMatch(/gemini-only sentinel/);
  });
});

sqliteDescribe("Devin verdicts — planted + clean on a real db", () => {
  let tmp = "", home = "", prevHome: string | undefined;
  const dbPathOf = (base: string) => join(base, "cli", "sessions.db");
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "rr-devinv-"));
    home = mkdtempSync(join(tmpdir(), "rr-devinv-home-"));
    prevHome = process.env.HOME; process.env.HOME = home; process.env.USERPROFILE = home;
    mkdirSync(join(tmp, "proj"), { recursive: true });
  });
  afterEach(() => { process.env.HOME = prevHome; rmSync(tmp, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });
  const stub = (r: Rule): CheckResult => ({ ruleId: r.id, ruleTitle: r.title, ruleSource: r.source, status: "UNCLEAR", needsHuman: true, evidence: "" });
  const rule = (proj: string, text: string) => writeFileSync(join(proj, "AGENTS.md"), `# Rules\n- ${text}\n`);
  const pushVerdict = async (proj: string) => {
    const events = parseDevinTranscript(`${dbPathOf(tmp)}#sess1`);
    const { results } = await evaluateSession(proj, loadRules(proj, "devin"), events, false, stub);
    return results.find((r) => /main/i.test(r.ruleTitle))?.status;
  };

  // A FORBID rule ("never push to main directly") routes to the deterministic
  // git-branch check, which CAN fail: a push to main with no feature-branch
  // target is a real, provable violation regardless of permission mode.
  it("planted: a push to main under a 'never push to main directly' rule is Broken (FAIL)", async () => {
    const proj = join(tmp, "proj");
    rule(proj, "Never push to the `main` branch directly.");
    buildDb(dbPathOf(tmp), {
      cwd: proj, mainChainId: 2, nodes: [
        { node_id: 0, parent: null, msg: user("get the branch up to date") },
        { node_id: 1, parent: 0, msg: asst("", [call("c1", "exec", { command: "git push origin main" })]) },
        { node_id: 2, parent: 1, msg: tool("c1", "pushed") },
      ],
    });
    expect(await pushVerdict(proj)).toBe("FAIL");
  });

  // An ASK rule ("without asking") routes to the approval gate. A push the user
  // approved in the prompt reads as Followed (PASS) — the Devin-specific point:
  // the approval arrives as a plain user turn, which is what sessions.db records.
  it("approved: the user approving the push in the prompt → Followed (PASS)", async () => {
    const proj = join(tmp, "proj");
    rule(proj, "Never push to `main` without asking me first.");
    buildDb(dbPathOf(tmp), {
      cwd: proj, mainChainId: 3, nodes: [
        { node_id: 0, parent: null, msg: user("push to main, I approve the push") },
        { node_id: 1, parent: 0, msg: asst("", [call("c1", "exec", { command: "git push origin main" })]) },
        { node_id: 2, parent: 1, msg: tool("c1", "pushed") },
        { node_id: 3, parent: 2, msg: asst("done") },
      ],
    });
    expect(await pushVerdict(proj)).toBe("PASS");
  });

  // Same ASK rule, NO approval and no recorded permission mode: honest UNCLEAR,
  // never a FAIL — a permission prompt the user clicked leaves no trace, so a
  // FAIL here would risk accusing someone who was asked and agreed. (This is the
  // control proving the PASS above comes from the approval, not from the adapter.)
  it("no approval + unknown mode → UNCLEAR, not a false accusation", async () => {
    const proj = join(tmp, "proj");
    rule(proj, "Never push to `main` without asking me first.");
    buildDb(dbPathOf(tmp), {
      cwd: proj, mainChainId: 2, nodes: [
        { node_id: 0, parent: null, msg: user("get the branch up to date") },
        { node_id: 1, parent: 0, msg: asst("", [call("c1", "exec", { command: "git push origin main" })]) },
        { node_id: 2, parent: 1, msg: tool("c1", "pushed") },
      ],
    });
    expect(await pushVerdict(proj)).toBe("UNCLEAR");
  });

  it("clean: only reading a file (no push) is not Broken", async () => {
    const proj = join(tmp, "proj");
    rule(proj, "Never push to the `main` branch directly.");
    buildDb(dbPathOf(tmp), {
      cwd: proj, mainChainId: 2, nodes: [
        { node_id: 0, parent: null, msg: user("what's in app.js?") },
        { node_id: 1, parent: 0, msg: asst("", [call("c1", "read", { file_path: join(proj, "app.js") })]) },
        { node_id: 2, parent: 1, msg: tool("c1", "console.log(1)") },
      ],
    });
    const { results } = await evaluateSession(proj, loadRules(proj, "devin"), parseDevinTranscript(`${dbPathOf(tmp)}#sess1`), false, stub);
    expect(results.some((r) => r.status === "FAIL")).toBe(false);
  });
});
