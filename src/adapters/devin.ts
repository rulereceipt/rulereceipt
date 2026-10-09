import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TranscriptEvent } from "../types.js";
import { getSqlite, sqliteUnavailableWarning, type SqliteDb } from "./sqlite.js";

/**
 * Devin Desktop adapter (the Windsurf / Codeium "devin-cli" stack).
 *
 * Reader validated against a real local session (`showy-attention`, backend
 * "windsurf", model swe-1-6-slow, Devin Desktop 3.10.48, 2026-10-09).
 *
 * Store: one SQLite db, `~/.local/share/devin/cli/sessions.db` (node:sqlite,
 * read-only), holding EVERY session — so, like OpenCode's db, a session is
 * addressed by a HANDLE `<dbPath>#<session_id>` (the `#` never appears in the
 * store path). `--transcript <handle>` and auto-detect both route here.
 *   sessions       (id, working_directory, backend_type, model, agent_mode,
 *                   main_chain_id, hidden, last_activity_at, …)
 *   message_nodes  (row_id, session_id, node_id, parent_node_id,
 *                   chat_message JSON, created_at) — a FOREST: retries fork the
 *                   graph, so the same prompt repeats across sibling node_ids.
 *                   The real transcript is the single path from the session's
 *                   `main_chain_id` head back to a root; walking parent pointers
 *                   from the head dedupes every abandoned retry branch.
 *
 * chat_message JSON:
 *   role:"system"    -> skip (tool preamble, skills, the always-on <rules> block)
 *   role:"user"      -> user text (content: string | [{type:"text",text}])
 *   role:"assistant" -> content text (if any) + tool_calls[]:
 *       read  {file_path}                        -> Read {file_path}
 *       exec  {command}                          -> Bash {command}
 *       edit  {file_path, old_string, new_string}-> Edit {…}
 *       write/create {file_path, …}              -> Write {…}
 *       <other>                                  -> generic tool_use {toolName,input}
 *     `thinking` is ignored (reasoning, like codex/cline).
 *   role:"tool"      -> tool_result keyed by tool_call_id; isError from
 *                       metadata.extensions["chisel/tool_result_meta"].success===false.
 *
 * Why NOT ~/Library/Application Support/Devin/User/acp-messages/*.db: those hold
 * the agent side only (agent_message / agent_thought / tool_call) with NO user
 * turns, so an approval ("I approve the push") would be invisible and a push
 * would read as can't-tell. sessions.db has the user turns.
 *
 * RESILIENCE: only the fields above; unknown roles / tools / bad rows skipped,
 * never guessed; `devinFormatIsKnown` gates auto-use. Read-only; opens nothing
 * but sessions.db.
 */

function baseDir(): string {
  const env = process.env.DEVIN_DIR?.trim();
  return env && env.length > 0 ? env : join(homedir(), ".local", "share", "devin", "cli");
}
function devinDbPath(): string { return join(baseDir(), "sessions.db"); }

function realpathOr(p: string): string { try { return realpathSync(p); } catch { return p; } }
function str(v: unknown): string | undefined { return typeof v === "string" && v.length > 0 ? v : undefined; }
function rec(v: unknown): Record<string, unknown> { return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {}; }
function arr(v: unknown): unknown[] { return Array.isArray(v) ? v : []; }
function safeParse(s: unknown): Record<string, unknown> | null { if (typeof s !== "string") return null; try { return rec(JSON.parse(s)); } catch { return null; } }
function iso(ms: unknown): string {
  if (typeof ms === "number" && Number.isFinite(ms)) { try { return new Date(ms).toISOString(); } catch { return ""; } }
  return "";
}

const DB_FRAG = "#";
/** Split a `<dbPath>#<session_id>` handle; null for a plain file path. */
function splitDbHandle(p: string): { dbPath: string; sessionId: string } | null {
  const i = p.lastIndexOf(DB_FRAG);
  if (i <= 0) return null;
  const dbPath = p.slice(0, i);
  const sessionId = p.slice(i + 1);
  if (!/sessions\.db$/i.test(dbPath) || sessionId.length === 0) return null;
  return { dbPath, sessionId };
}

let warnedNoSqlite = false;
function withDb<T>(dbPath: string, fn: (db: SqliteDb) => T, fallback: T): T {
  // Silent when there is no db (a machine that never used Devin is not nagged on
  // every check). Warn only when a sessions.db exists but this Node is too old.
  if (!existsSync(dbPath)) return fallback;
  const open = getSqlite();
  if (!open) {
    if (!warnedNoSqlite) { warnedNoSqlite = true; process.stderr.write(sqliteUnavailableWarning("Devin") + "\n"); }
    return fallback;
  }
  let db: SqliteDb | undefined;
  try { db = open(dbPath); return fn(db); } catch { return fallback; } finally { try { db?.close(); } catch { /* ignore */ } }
}

/** Devin session handles for this cwd, each with the session's last-activity time. */
export function listDevinSessions(cwd: string): string[] {
  const dbPath = devinDbPath();
  const target = realpathOr(cwd);
  return withDb(dbPath, (db) => {
    const rows = db.all("SELECT id, working_directory, last_activity_at, hidden FROM sessions") as { id?: string; working_directory?: string; last_activity_at?: number; hidden?: number }[];
    const out: { handle: string; mtimeMs: number }[] = [];
    for (const r of rows) {
      if (typeof r.id !== "string" || typeof r.working_directory !== "string") continue;
      if (r.hidden) continue; // hidden/archived sessions are not "the newest session"
      if (realpathOr(r.working_directory) !== target) continue;
      out.push({ handle: `${dbPath}${DB_FRAG}${r.id}`, mtimeMs: Number(r.last_activity_at) || 0 });
    }
    return out.sort((a, b) => b.mtimeMs - a.mtimeMs).map((h) => h.handle);
  }, []);
}

/** cwd a Devin session ran in (its `working_directory`). */
export function devinSessionCwd(sessionFile: string): string | null {
  const frag = splitDbHandle(sessionFile);
  if (!frag) return null;
  return withDb(frag.dbPath, (db) => {
    const r = db.all("SELECT working_directory FROM sessions WHERE id = ?", frag.sessionId) as { working_directory?: string }[];
    return str(r[0]?.working_directory) ?? null;
  }, null);
}

/** True for a Devin session handle `<…sessions.db>#<id>` that the db actually holds. */
export function devinFormatIsKnown(sessionFile: string): boolean {
  const frag = splitDbHandle(sessionFile);
  if (!frag) return false;
  return withDb(frag.dbPath, (db) => {
    const r = db.all("SELECT 1 AS n FROM sessions WHERE id = ?", frag.sessionId);
    return r.length > 0;
  }, false);
}

/** Map one assistant tool_call to a tool_use event (canonical tool name). */
function toolCallToEvent(tc: Record<string, unknown>, ts: string): TranscriptEvent | null {
  const name = str(tc.name);
  if (!name) return null;
  const id = str(tc.id);
  const args = rec(tc.arguments);
  const idPart = id ? { toolUseId: id } : {};
  const lower = name.toLowerCase();
  if (lower === "read") {
    return { role: "assistant", kind: "tool_use", toolName: "Read", input: { file_path: str(args.file_path) ?? str(args.path) }, timestamp: ts, ...idPart };
  }
  if (lower === "exec" || lower === "run" || lower === "shell" || lower === "command") {
    const command = str(args.command) ?? str(args.cmd);
    return { role: "assistant", kind: "tool_use", toolName: "Bash", input: { command }, timestamp: ts, ...idPart };
  }
  if (lower === "edit" || lower === "replace" || lower === "str_replace") {
    return { role: "assistant", kind: "tool_use", toolName: "Edit", input: { file_path: str(args.file_path) ?? str(args.path), old_string: args.old_string, new_string: args.new_string }, timestamp: ts, ...idPart };
  }
  if (lower === "write" || lower === "create" || lower === "create_file") {
    return { role: "assistant", kind: "tool_use", toolName: "Write", input: { file_path: str(args.file_path) ?? str(args.path), content: args.content }, timestamp: ts, ...idPart };
  }
  return { role: "assistant", kind: "tool_use", toolName: name, input: args, timestamp: ts, ...idPart };
}

/** Text from a chat_message content, which is a string or an array of parts. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p) => { const pp = rec(p); return pp.type === "text" ? (str(pp.text) ?? "") : ""; }).filter(Boolean).join("\n");
  }
  return "";
}

/** Map one message_node's chat_message to neutral events. */
function nodeToEvents(msg: Record<string, unknown>, ts: string): TranscriptEvent[] {
  const role = msg.role;
  if (role === "system") return []; // tool preamble / skills / the <rules> block
  if (role === "user") {
    const text = contentText(msg.content);
    return text.trim().length > 0 ? [{ role: "user", kind: "text", text, timestamp: ts }] : [];
  }
  if (role === "assistant") {
    const out: TranscriptEvent[] = [];
    const text = contentText(msg.content);
    if (text.trim().length > 0) out.push({ role: "assistant", kind: "text", text, timestamp: ts });
    for (const raw of arr(msg.tool_calls)) {
      const ev = toolCallToEvent(rec(raw), ts);
      if (ev) out.push(ev);
    }
    return out;
  }
  if (role === "tool") {
    const id = str(msg.tool_call_id);
    const content = contentText(msg.content) || (typeof msg.content === "string" ? msg.content : "");
    const meta = rec(rec(rec(msg.metadata).extensions)["chisel/tool_result_meta"]);
    const isError = meta.success === false;
    return [{ role: "user", kind: "tool_result", content: String(content).slice(0, 4000), isError, timestamp: ts, ...(id ? { toolUseId: id } : {}) }];
  }
  return [];
}

/**
 * The main chain: walk parent pointers from the session's `main_chain_id` head
 * back to a root, then reverse to chronological order. This is what dedupes the
 * retry branches (a forest) down to the one transcript the user actually saw.
 * When `main_chain_id` is absent/dangling, fall back to the node with the latest
 * created_at as the head (best effort), rather than emitting every branch.
 */
function mainChain(rows: { node_id: number; parent_node_id: number | null; chat_message: string; created_at: number }[], head: number | null): typeof rows {
  const byId = new Map<number, (typeof rows)[number]>();
  for (const r of rows) byId.set(r.node_id, r);
  let start = head != null && byId.has(head) ? head : null;
  if (start === null) {
    let best: (typeof rows)[number] | null = null;
    for (const r of rows) if (!best || r.created_at > best.created_at || (r.created_at === best.created_at && r.node_id > best.node_id)) best = r;
    start = best ? best.node_id : null;
  }
  const chain: typeof rows = [];
  const seen = new Set<number>();
  let cur: number | null = start;
  while (cur != null && byId.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    const node = byId.get(cur)!;
    chain.push(node);
    cur = node.parent_node_id;
  }
  return chain.reverse();
}

/** Parse one Devin session (a `<…sessions.db>#<id>` handle) into neutral events. */
export function parseDevinTranscript(sessionFile: string): TranscriptEvent[] {
  const frag = splitDbHandle(sessionFile);
  if (!frag) return [];
  return withDb(frag.dbPath, (db) => {
    const sess = db.all("SELECT main_chain_id FROM sessions WHERE id = ?", frag.sessionId) as { main_chain_id?: number | null }[];
    if (sess.length === 0) return [];
    const head = typeof sess[0].main_chain_id === "number" ? sess[0].main_chain_id : null;
    const rows = (db.all(
      "SELECT node_id, parent_node_id, chat_message, created_at FROM message_nodes WHERE session_id = ?",
      frag.sessionId
    ) as { node_id?: number; parent_node_id?: number | null; chat_message?: string; created_at?: number }[])
      .filter((r): r is { node_id: number; parent_node_id: number | null; chat_message: string; created_at: number } =>
        typeof r.node_id === "number" && typeof r.chat_message === "string")
      .map((r) => ({ node_id: r.node_id, parent_node_id: typeof r.parent_node_id === "number" ? r.parent_node_id : null, chat_message: r.chat_message, created_at: Number(r.created_at) || 0 }));
    const out: TranscriptEvent[] = [];
    for (const node of mainChain(rows, head)) {
      const msg = safeParse(node.chat_message);
      if (msg) out.push(...nodeToEvents(msg, iso(node.created_at)));
    }
    return out;
  }, []);
}

/** True when a `--transcript` path is a Devin handle (used for early routing). */
export function isDevinHandle(sessionFile: string): boolean {
  return splitDbHandle(sessionFile) !== null;
}
