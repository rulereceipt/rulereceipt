import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { parseOpenCodeTranscript, openCodeFormatIsKnown, listOpenCodeSessions, openCodeSessionCwd } from "../src/adapters/opencode.js";
import { parseSessionFile } from "../src/adapters/index.js";
import { evaluateSession } from "../src/evaluate.js";
import { loadRules } from "../src/rules.js";
import type { CheckResult, Rule, TranscriptEvent } from "../src/types.js";

/** OpenCode adapter — EXPERIMENTAL. Builds a synthetic 3-dir JSON store. */
function w(file: string, obj: unknown) { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, JSON.stringify(obj)); }
function buildStore(storage: string, projectDir: string, cmd: string): string {
  const ses = join(storage, "session", "p1", "ses_abc.json");
  w(ses, { id: "ses_abc", directory: projectDir, time: { updated: 2 } });
  w(join(storage, "message", "ses_abc", "msg_001.json"), { id: "msg_001", role: "user" });
  w(join(storage, "part", "msg_001", "prt_001.json"), { type: "text", text: "ship it" });
  w(join(storage, "message", "ses_abc", "msg_002.json"), { id: "msg_002", role: "assistant" });
  w(join(storage, "part", "msg_002", "prt_001.json"), { type: "text", text: "ok" });
  w(join(storage, "part", "msg_002", "prt_002.json"), { type: "tool", tool: "bash", callID: "c1", state: { input: { command: cmd }, status: "completed", output: "done" } });
  return ses;
}

describe("parseOpenCodeTranscript maps the 3-dir JSON store", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "rr-oc-")); });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("joins session→message→part and maps a shell tool to canonical Bash", () => {
    const ses = buildStore(join(tmp, "storage"), join(tmp, "proj"), "git push origin main");
    const events = parseOpenCodeTranscript(ses);
    expect(events.some((e) => e.kind === "text" && e.role === "user" && e.text === "ship it")).toBe(true);
    const bash = events.find((e) => e.kind === "tool_use" && e.toolName === "Bash") as Extract<TranscriptEvent, { kind: "tool_use" }> | undefined;
    expect((bash?.input as { command?: string } | undefined)?.command).toBe("git push origin main");
    expect(events.some((e) => e.kind === "tool_result")).toBe(true);
  });

  it("openCodeFormatIsKnown true for a ses_ file, false otherwise", () => {
    const ses = buildStore(join(tmp, "storage"), join(tmp, "proj"), "ls");
    expect(openCodeFormatIsKnown(ses)).toBe(true);
    const other = join(tmp, "x.json"); writeFileSync(other, JSON.stringify({ id: "other", type: "user" }));
    expect(openCodeFormatIsKnown(other)).toBe(false);
  });

  it("listOpenCodeSessions finds a session by cwd (via XDG_DATA_HOME)", () => {
    const prev = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = join(tmp, "xdg");
    try {
      buildStore(join(tmp, "xdg", "opencode", "storage"), join(tmp, "proj"), "ls");
      const found = listOpenCodeSessions(join(tmp, "proj"));
      expect(found.length).toBe(1);
      expect(found[0].endsWith("ses_abc.json")).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = prev;
    }
  });

  it("parseSessionFile routes an OpenCode ses_ file to the OpenCode reader", () => {
    const ses = buildStore(join(tmp, "storage"), join(tmp, "proj"), "git push origin main");
    const events = parseSessionFile(ses);
    expect(events.some((e) => e.kind === "tool_use" && (e.input as { command?: string }).command === "git push origin main")).toBe(true);
  });
});

/**
 * OpenCode 1.18+ stores sessions in SQLite (opencode.db), not the legacy JSON
 * store. Real incident 2026-10-08: a real 1.18.35 session was invisible because
 * the adapter only read the JSON store. These build a real temp db in the shape
 * the reader expects and address it by the `<db>#ses_id` handle. Skipped where
 * node:sqlite is absent (Node < 22.5) — the same degradation the reader does.
 */
let DatabaseSync: (new (p: string) => { exec(s: string): void; prepare(s: string): { run(...a: unknown[]): void }; close(): void }) | undefined;
try { DatabaseSync = createRequire(import.meta.url)("node:sqlite").DatabaseSync; } catch { /* older Node */ }
const sqliteDescribe = DatabaseSync ? describe : describe.skip;

sqliteDescribe("OpenCode SQLite store (opencode.db)", () => {
  let tmp = "", xdgPrev: string | undefined;
  const dbPathOf = (base: string) => join(base, "xdg", "opencode", "opencode.db");

  function buildDb(dbPath: string, directory: string) {
    mkdirSync(join(dbPath, ".."), { recursive: true });
    const db = new DatabaseSync!(dbPath);
    db.exec("CREATE TABLE session (id TEXT, directory TEXT, time_updated INTEGER, time_archived INTEGER)");
    db.exec("CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT)");
    db.exec("CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)");
    db.prepare("INSERT INTO session VALUES (?,?,?,?)").run("ses_t1", directory, 1000, null);
    db.prepare("INSERT INTO message VALUES (?,?,?,?)").run("m1", "ses_t1", 1, JSON.stringify({ role: "user" }));
    db.prepare("INSERT INTO part VALUES (?,?,?,?,?)").run("p1", "m1", "ses_t1", 1, JSON.stringify({ type: "text", text: "ship it" }));
    db.prepare("INSERT INTO message VALUES (?,?,?,?)").run("m2", "ses_t1", 2, JSON.stringify({ role: "assistant" }));
    db.prepare("INSERT INTO part VALUES (?,?,?,?,?)").run("p2", "m2", "ses_t1", 2, JSON.stringify({ type: "tool", tool: "bash", callID: "c1", state: { input: { command: "git push origin main" }, status: "completed", output: "done" } }));
    db.prepare("INSERT INTO part VALUES (?,?,?,?,?)").run("p3", "m2", "ses_t1", 3, JSON.stringify({ type: "tool", tool: "edit", callID: "c2", state: { input: { filePath: join(directory, "app.js") }, status: "completed", output: "ok" } }));
    // An archived session in the same dir must NOT be listed as "the newest".
    db.prepare("INSERT INTO session VALUES (?,?,?,?)").run("ses_arch", directory, 5000, 5000);
    db.close();
  }

  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "rr-ocdb-")); xdgPrev = process.env.XDG_DATA_HOME; process.env.XDG_DATA_HOME = join(tmp, "xdg"); });
  afterEach(() => { if (xdgPrev === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = xdgPrev; rmSync(tmp, { recursive: true, force: true }); });

  it("parses a db session by its <db>#ses_id handle (text + bash + edit)", () => {
    const dir = join(tmp, "proj");
    buildDb(dbPathOf(tmp), dir);
    const handle = `${dbPathOf(tmp)}#ses_t1`;
    const events = parseOpenCodeTranscript(handle);
    expect(events.some((e) => e.kind === "text" && e.role === "user" && e.text === "ship it")).toBe(true);
    const bash = events.find((e) => e.kind === "tool_use" && e.toolName === "Bash") as Extract<TranscriptEvent, { kind: "tool_use" }> | undefined;
    expect((bash?.input as { command?: string } | undefined)?.command).toBe("git push origin main");
    expect(events.some((e) => e.kind === "tool_use" && e.toolName === "Edit")).toBe(true);
  });

  it("listOpenCodeSessions returns the db handle and SKIPS the archived session", () => {
    const dir = join(tmp, "proj");
    buildDb(dbPathOf(tmp), dir);
    const found = listOpenCodeSessions(dir);
    expect(found.length).toBe(1);
    expect(found[0]).toBe(`${dbPathOf(tmp)}#ses_t1`);
  });

  it("openCodeFormatIsKnown true for the handle; openCodeSessionCwd returns the session directory", () => {
    const dir = join(tmp, "proj");
    buildDb(dbPathOf(tmp), dir);
    const handle = `${dbPathOf(tmp)}#ses_t1`;
    expect(openCodeFormatIsKnown(handle)).toBe(true);
    expect(openCodeSessionCwd(handle)).toBe(dir);
  });

  it("parseSessionFile routes a db handle (not a real file) to the reader", () => {
    const dir = join(tmp, "proj");
    buildDb(dbPathOf(tmp), dir);
    const events = parseSessionFile(`${dbPathOf(tmp)}#ses_t1`);
    expect(events.some((e) => e.kind === "tool_use" && (e.input as { command?: string }).command === "git push origin main")).toBe(true);
  });
});

describe("OpenCode adapter — same engine, planted + clean", () => {
  let tmp: string, home: string, prevHome: string | undefined;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "rr-ocv-"));
    home = mkdtempSync(join(tmpdir(), "rr-ocv-home-"));
    prevHome = process.env.HOME; process.env.HOME = home; process.env.USERPROFILE = home;
    mkdirSync(join(tmp, "proj"), { recursive: true });
    writeFileSync(join(tmp, "proj", "CLAUDE.md"), "## 1. Branch\nNever push to the `main` branch directly.\n");
  });
  afterEach(() => { process.env.HOME = prevHome; rmSync(tmp, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });
  const stub = (r: Rule): CheckResult => ({ ruleId: r.id, ruleTitle: r.title, ruleSource: r.source, status: "UNCLEAR", needsHuman: true, evidence: "" });

  it("planted: an OpenCode session that pushes to main is Broken", async () => {
    const ses = buildStore(join(tmp, "storage"), join(tmp, "proj"), "git push origin main");
    const { results } = await evaluateSession(join(tmp, "proj"), loadRules(join(tmp, "proj")), parseOpenCodeTranscript(ses), false, stub);
    expect(results.find((r) => /branch/i.test(r.ruleTitle))?.status).toBe("FAIL");
  });
  it("clean: only running tests is not Broken", async () => {
    const ses = buildStore(join(tmp, "storage"), join(tmp, "proj"), "npm test");
    const { results } = await evaluateSession(join(tmp, "proj"), loadRules(join(tmp, "proj")), parseOpenCodeTranscript(ses), false, stub);
    expect(results.some((r) => r.status === "FAIL")).toBe(false);
  });
});
