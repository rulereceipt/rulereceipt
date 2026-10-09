import { existsSync, readFileSync, readdirSync, statSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import type { TranscriptEvent } from "../types.js";

/**
 * OpenCode adapter.
 *
 * Two on-disk stores, read in one list:
 *   1. SQLite `opencode.db` (OpenCode ~1.18+, the current default) — session /
 *      message / part rows, each with a JSON `data` blob in the SAME shape as the
 *      legacy file store. Needs `node:sqlite` (Node 22.5+); without it those
 *      sessions are skipped (noted once), the same graceful-degrade pattern the
 *      Codex reader uses for zstd.
 *   2. The legacy JSON file store (older OpenCode) — kept so a machine that still
 *      has it keeps working. Format documented by yigitkonur/cli-continues (MIT,
 *      src/parsers/opencode.ts, pinned e486cd22a592d89d890cff056624647fbe9cbe80).
 *      Credit: NOTICE.md / REUSE.md.
 *
 * Store roots: `$XDG_DATA_HOME/opencode` or `~/.local/share/opencode`, with the
 * db at `<base>/opencode.db` and the file store under `<base>/storage/` as a
 * 3-directory join:
 *   session/<proj>/ses_*.json   → { id, projectID, directory, time:{updated} }
 *   message/<sessionId>/msg_*.json → { id, role }
 *   part/<messageId>/prt_*.json    → { type:'text'|'tool'|…, text?, tool?, callID?,
 *                                      state:{ input, status, output, error } }
 * cwd = session.directory, else project/<projectID>.json `.worktree`.
 *   text part  -> text (role of its message)
 *   tool part  -> tool_use (shell -> canonical Bash) + a tool_result from its state.
 *
 * A db session is addressed by a HANDLE `<dbPath>#<ses_id>` (the `#` never
 * appears in a real store path); `--transcript <handle>` and auto-detect both
 * route it here. A legacy file session is addressed by its `ses_*.json` path,
 * whose message/part dirs resolve RELATIVE to it.
 *
 * RESILIENCE: only the fields above; unknown part types / bad rows skipped,
 * never guessed; `openCodeFormatIsKnown` gates use.
 */

function realpathOr(p: string): string { try { return realpathSync(p); } catch { return p; } }
function str(v: unknown): string | undefined { return typeof v === "string" && v.length > 0 ? v : undefined; }
function rec(v: unknown): Record<string, unknown> { return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {}; }
function safeParse(s: unknown): Record<string, unknown> | null { if (typeof s !== "string") return null; try { return rec(JSON.parse(s)); } catch { return null; } }

function baseDir(): string {
  const xdg = process.env.XDG_DATA_HOME?.trim();
  return xdg && xdg.length > 0 ? join(xdg, "opencode") : join(homedir(), ".local", "share", "opencode");
}
function storageDir(): string { return join(baseDir(), "storage"); }
function openCodeDbPath(): string { return join(baseDir(), "opencode.db"); }

/* ── SQLite store (opencode.db) ─────────────────────────────────────────────
 * node:sqlite is Node 22.5+. Loaded LAZILY (only when an opencode.db actually
 * needs reading), so a plain Claude Code `check`/`doctor` never touches it —
 * and the one-time "SQLite is an experimental feature" ExperimentalWarning that
 * Node 22/23 prints on first require is suppressed, since it would otherwise
 * leak onto stderr for every run once this module is imported. An older Node
 * (<22.5) that lacks node:sqlite degrades (db sessions skipped, noted once)
 * instead of crashing — the same graceful-degrade pattern codex.ts uses for
 * zstd. */
interface SqliteDb { all(sql: string, ...params: unknown[]): Record<string, unknown>[]; close(): void; }

/** Require node:sqlite, muting ONLY its own experimental warning. */
function loadSqlite(): ((path: string) => SqliteDb) | undefined {
  const origEmit = process.emitWarning.bind(process);
  // Swallow exactly "SQLite is an experimental feature" (ExperimentalWarning);
  // every other warning still passes straight through.
  (process as unknown as { emitWarning: typeof process.emitWarning }).emitWarning = ((warning: string | Error, ...rest: unknown[]): void => {
    const opt = rest[0];
    const type = typeof opt === "string" ? opt : (opt && typeof opt === "object" ? (opt as { type?: string }).type : undefined);
    const msg = typeof warning === "string" ? warning : warning?.message;
    if (type === "ExperimentalWarning" && typeof msg === "string" && /sqlite/i.test(msg)) return;
    (origEmit as (...a: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    const req = createRequire(import.meta.url);
    const { DatabaseSync } = req("node:sqlite") as { DatabaseSync: new (p: string, o?: { readOnly?: boolean }) => { prepare(sql: string): { all(...p: unknown[]): unknown[] }; close(): void } };
    return (path: string) => {
      const db = new DatabaseSync(path, { readOnly: true });
      return {
        all: (sql, ...params) => db.prepare(sql).all(...params) as Record<string, unknown>[],
        close: () => db.close(),
      };
    };
  } catch {
    return undefined;
  } finally {
    process.emitWarning = origEmit;
  }
}

let sqliteResolved = false;
let sqliteOpener: ((path: string) => SqliteDb) | undefined;
/** Lazy, memoised node:sqlite opener. `RR_FORCE_NO_SQLITE=1` forces the
 * old-Node degraded path (used by tests, and a usable escape hatch). */
function getSqlite(): ((path: string) => SqliteDb) | undefined {
  if (/^(1|true|yes)$/i.test(process.env.RR_FORCE_NO_SQLITE ?? "")) return undefined;
  if (sqliteResolved) return sqliteOpener;
  sqliteResolved = true;
  sqliteOpener = loadSqlite();
  return sqliteOpener;
}

/** The exact stderr line shown when this Node can't read an agent's db. */
export function sqliteUnavailableWarning(agent: string): string {
  return `rulereceipt: reading ${agent} sessions needs Node 22.5+ (this is Node ${process.versions.node}); skipping ${agent}'s database. Upgrade Node to include them.`;
}
let warnedNoSqlite = false;
function warnNoSqlite(agent = "OpenCode"): void {
  if (warnedNoSqlite) return;
  warnedNoSqlite = true;
  process.stderr.write(sqliteUnavailableWarning(agent) + "\n");
}

const DB_FRAG = "#";
/** Split a `<dbPath>#<ses_id>` handle; null for a plain file path. */
function splitDbHandle(p: string): { dbPath: string; sessionId: string } | null {
  const i = p.lastIndexOf(DB_FRAG);
  if (i <= 0) return null;
  const dbPath = p.slice(0, i);
  const sessionId = p.slice(i + 1);
  if (!/opencode\.db$/i.test(dbPath) || !sessionId.startsWith("ses_")) return null;
  return { dbPath, sessionId };
}

function withDb<T>(dbPath: string, fn: (db: SqliteDb) => T, fallback: T): T {
  // Silent when there is no db to read — so a machine that never used OpenCode
  // (and runs an old Node) is not nagged on every `check`. Warn only when an
  // opencode.db actually exists but this Node is too old to open it.
  if (!existsSync(dbPath)) return fallback;
  const open = getSqlite();
  if (!open) { warnNoSqlite(); return fallback; }
  let db: SqliteDb | undefined;
  try { db = open(dbPath); return fn(db); } catch { return fallback; } finally { try { db?.close(); } catch { /* ignore */ } }
}

/** db session handles for this cwd, paired with the session's own update time. */
function listDbSessions(cwd: string): { handle: string; mtimeMs: number }[] {
  const dbPath = openCodeDbPath();
  const target = realpathOr(cwd);
  return withDb(dbPath, (db) => {
    const rows = db.all("SELECT id, directory, time_updated, time_archived FROM session") as { id?: string; directory?: string; time_updated?: number; time_archived?: number | null }[];
    const out: { handle: string; mtimeMs: number }[] = [];
    for (const r of rows) {
      if (typeof r.id !== "string" || typeof r.directory !== "string") continue;
      if (r.time_archived != null) continue; // archived/deleted sessions are not "the newest session"
      if (realpathOr(r.directory) !== target) continue;
      out.push({ handle: `${dbPath}${DB_FRAG}${r.id}`, mtimeMs: Number(r.time_updated) || 0 });
    }
    return out;
  }, []);
}

/** Parse one db session (message rows ordered, each with its part rows). */
function parseDbSession(dbPath: string, sessionId: string): TranscriptEvent[] {
  return withDb(dbPath, (db) => {
    const msgs = db.all("SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, id", sessionId) as { id?: string; data?: string }[];
    const out: TranscriptEvent[] = [];
    for (const m of msgs) {
      const md = safeParse(m.data);
      const role = md?.role === "assistant" ? "assistant" : md?.role === "user" ? "user" : undefined;
      if (!role || typeof m.id !== "string") continue;
      const parts = db.all("SELECT data FROM part WHERE message_id = ? ORDER BY time_created, id", m.id) as { data?: string }[];
      for (const p of parts) {
        const part = safeParse(p.data);
        if (part) out.push(...partToEvents(role, part));
      }
    }
    return out;
  }, []);
}

function readJson(file: string): Record<string, unknown> | null {
  try { const o = JSON.parse(readFileSync(file, "utf-8")); return rec(o); } catch { return null; }
}

/** storage root for a given session file (…/storage/session/<proj>/ses_X.json). */
function storageRootOf(sessionFile: string): string {
  return join(dirname(sessionFile), "..", "..");
}

/** cwd of a session JSON: its `directory`, else project/<projectID>.json .worktree. */
function sessionCwd(sessionFile: string, s: Record<string, unknown>): string | null {
  const dir = str(s.directory);
  if (dir) return dir;
  const pid = str(s.projectID);
  if (pid) {
    const proj = readJson(join(storageRootOf(sessionFile), "project", `${pid}.json`));
    if (proj) return str(proj.worktree) ?? null;
  }
  return null;
}

function listSessionJsonFiles(storage: string): string[] {
  const sessionBase = join(storage, "session");
  const out: string[] = [];
  let projs: string[] = [];
  try { projs = readdirSync(sessionBase); } catch { return out; }
  for (const p of projs) {
    const d = join(sessionBase, p);
    let names: string[] = [];
    try { names = readdirSync(d); } catch { continue; }
    for (const n of names) if (n.startsWith("ses_") && n.endsWith(".json")) out.push(join(d, n));
  }
  return out;
}

/**
 * OpenCode sessions for this cwd, newest first — from BOTH stores: the SQLite
 * db (handles, sorted by each session's own update time) and the legacy JSON
 * file store (paths, sorted by file mtime). Both time bases are epoch-ms, so
 * the merged list orders correctly across the two.
 */
export function listOpenCodeSessions(cwd: string): string[] {
  const target = realpathOr(cwd);
  const hits: { file: string; mtimeMs: number }[] = [];
  const storage = storageDir();
  if (existsSync(storage)) {
    for (const file of listSessionJsonFiles(storage)) {
      const s = readJson(file);
      if (!s) continue;
      const c = sessionCwd(file, s);
      if (c && realpathOr(c) !== target) continue;
      try { hits.push({ file, mtimeMs: statSync(file).mtimeMs }); } catch { /* skip */ }
    }
  }
  for (const d of listDbSessions(cwd)) hits.push({ file: d.handle, mtimeMs: d.mtimeMs });
  return hits.sort((a, b) => b.mtimeMs - a.mtimeMs).map((h) => h.file);
}

/** cwd of an OpenCode session, whether it is a db handle or a legacy file. */
export function openCodeSessionCwd(sessionFile: string): string | null {
  const frag = splitDbHandle(sessionFile);
  if (frag) {
    return withDb(frag.dbPath, (db) => {
      const r = db.all("SELECT directory FROM session WHERE id = ?", frag.sessionId) as { directory?: string }[];
      return str(r[0]?.directory) ?? null;
    }, null);
  }
  const s = readJson(sessionFile);
  return s ? sessionCwd(sessionFile, s) : null;
}

function sortedJson(dir: string): string[] {
  try { return readdirSync(dir).filter((f) => f.endsWith(".json")).sort(); } catch { return []; }
}

/** Map one OpenCode part (either store, same shape) to neutral events. */
function partToEvents(role: "user" | "assistant", part: Record<string, unknown>): TranscriptEvent[] {
  if (part.type === "text" && str(part.text)) {
    return [{ role, kind: "text", text: part.text as string, timestamp: "" }];
  }
  if (part.type === "tool" && role === "assistant") {
    const name = str(part.tool);
    if (!name) return [];
    const state = rec(part.state);
    const id = str(part.callID);
    const content = str(state.output) ?? str(state.error) ?? "";
    return [
      toToolUse(name, rec(state.input), id, ""),
      { role: "user", kind: "tool_result", toolUseId: id, content: content.slice(0, 2000), isError: state.status === "error", timestamp: "" },
    ];
  }
  return [];
}

function toToolUse(name: string, input: Record<string, unknown>, id: string | undefined, ts: string): TranscriptEvent {
  const command = str(input.command) ?? str(input.cmd);
  const filePath = str(input.file_path) ?? str(input.path) ?? str(input.filePath);
  const lower = name.toLowerCase();
  if (command && (/(shell|bash|terminal|exec|run|command)/.test(lower) || !filePath)) {
    return { role: "assistant", kind: "tool_use", toolName: "Bash", toolUseId: id, input: { command }, timestamp: ts };
  }
  if (filePath && /(write|create|edit|replace|patch|insert|modif|apply)/.test(lower)) {
    return { role: "assistant", kind: "tool_use", toolName: /(edit|replace|patch|apply)/.test(lower) ? "Edit" : "Write", toolUseId: id, input: { file_path: filePath, ...input }, timestamp: ts };
  }
  if (filePath && /(read|view|open|cat|show)/.test(lower)) {
    return { role: "assistant", kind: "tool_use", toolName: "Read", toolUseId: id, input: { file_path: filePath }, timestamp: ts };
  }
  return { role: "assistant", kind: "tool_use", toolName: name, toolUseId: id, input, timestamp: ts };
}

/** True for a db handle `<…opencode.db>#ses_*`, or a legacy session JSON (id `ses_`). */
export function openCodeFormatIsKnown(sessionFile: string): boolean {
  if (splitDbHandle(sessionFile)) return true;
  const s = readJson(sessionFile);
  return Boolean(s && str(s.id)?.startsWith("ses_"));
}

/** Parse one OpenCode session — a db handle or a legacy ses_*.json — into neutral events. */
export function parseOpenCodeTranscript(sessionFile: string): TranscriptEvent[] {
  const frag = splitDbHandle(sessionFile);
  if (frag) return parseDbSession(frag.dbPath, frag.sessionId);

  const s = readJson(sessionFile);
  const sessionId = s ? str(s.id) : undefined;
  if (!s || !sessionId) return [];
  const root = storageRootOf(sessionFile);
  const messageDir = join(root, "message", sessionId);
  const out: TranscriptEvent[] = [];
  for (const msgFile of sortedJson(messageDir)) {
    const m = readJson(join(messageDir, msgFile));
    if (!m) continue;
    const role = m.role === "assistant" ? "assistant" : m.role === "user" ? "user" : undefined;
    const msgId = str(m.id);
    if (!role || !msgId) continue;
    const partDir = join(root, "part", msgId);
    for (const prtFile of sortedJson(partDir)) {
      const part = readJson(join(partDir, prtFile));
      if (part) out.push(...partToEvents(role, part));
    }
  }
  return out;
}
