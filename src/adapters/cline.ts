import { existsSync, readFileSync, readdirSync, statSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TranscriptEvent } from "../types.js";

/**
 * Cline adapter — reader validated against a real Cline CLI session
 * (cli v3.0.70, provider cline, model cline-free/mimo-v2.6-flash, 2026-10-09).
 *
 * Storage: `~/.cline/data/sessions/<id>/` holds two files —
 *   <id>.json           session meta: { session_id, cwd, workspace_root,
 *                        provider:"cline", model, prompt, messages_path }
 *   <id>.messages.json  the transcript: { sessionId, origin:{source}, messages:[…] }
 *
 * The canonical session path is the META file (<id>.json): it is self-describing
 * (cwd + messages_path), and parse follows messages_path to the transcript. A
 * user may also point --transcript straight at the .messages.json; both are
 * recognised.
 *
 * Each message is { role:'user'|'assistant', content:[part], ts } where a part is:
 *   {type:'text', text}                              -> text (role of the message)
 *   {type:'thinking', thinking}                      -> ignored (reasoning, like codex)
 *   {type:'tool_use', id, name, input}               -> one or more tool_use:
 *       read_files  {files:[…]}        -> Read {file_path:[…]}        (not a mutation)
 *       run_commands{commands:[…]}     -> one Bash per command (id#k), {command}
 *       editor      {path,old_text,new_text} -> Edit {file_path, old_string, new_string}
 *       ask_question{question,options} -> the QUESTION as assistant text (the ANSWER
 *                                         arrives as its tool_result, below)
 *       <other>                        -> generic tool_use {toolName:name, input}
 *   {type:'tool_result', tool_use_id, name, content} -> tool_result(s):
 *       run_commands  content:[{query,result,success,error}] -> a tool_result per
 *                     command (id#k), so each command keeps its own output
 *       editor        content: JSON string                  -> one tool_result
 *       ask_question  content: the chosen option STRING      -> a USER-role text
 *                     event (Cline's ask-user approval, mapped like Copilot's: the
 *                     user's selection is their "yes", so an authorised push reads
 *                     as Followed, not can't-tell)
 *       read_files / other                                   -> one tool_result
 *
 * RESILIENCE: only the fields above; unknown parts / tools / bad rows skipped,
 * never guessed; `clineFormatIsKnown` gates auto-use so another tool's JSON is
 * not mis-read. Read-only; never opens settings/, providers.json, oauth, or the
 * db/*.db stores.
 */

function baseDir(): string {
  const env = process.env.CLINE_DIR?.trim();
  return env && env.length > 0 ? env : join(homedir(), ".cline");
}
function sessionsDir(): string { return join(baseDir(), "data", "sessions"); }
function realpathOr(p: string): string { try { return realpathSync(p); } catch { return p; } }
function str(v: unknown): string | undefined { return typeof v === "string" && v.length > 0 ? v : undefined; }
function rec(v: unknown): Record<string, unknown> { return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {}; }
function arr(v: unknown): unknown[] { return Array.isArray(v) ? v : []; }
function safeJson(path: string): Record<string, unknown> | null {
  try { const o = JSON.parse(readFileSync(path, "utf-8")) as unknown; return rec(o); } catch { return null; }
}
function iso(ts: unknown): string {
  if (typeof ts === "number" && Number.isFinite(ts)) { try { return new Date(ts).toISOString(); } catch { return ""; } }
  if (typeof ts === "string" && ts.length > 0) return ts;
  return "";
}

/** True for a Cline session meta file. */
function isMeta(o: Record<string, unknown>): boolean {
  return o.provider === "cline" || (typeof o.messages_path === "string" && typeof o.session_id === "string");
}
/**
 * True for a Cline messages file. Distinguished from a Gemini session (also
 * `{sessionId, messages:[…]}`) by Cline's `origin` object OR its structural
 * signature: messages are `{role, content:[parts]}` (Gemini's are `{type,
 * content:string}`). A bare `sessionId` is NOT enough — that collides with Gemini.
 */
function isMessages(o: Record<string, unknown>): boolean {
  if (!Array.isArray(o.messages)) return false;
  const org = rec(o.origin);
  if (typeof org.source === "string" || typeof org.sessionId === "string") return true;
  const first = rec(o.messages[0]);
  return (first.role === "user" || first.role === "assistant") && Array.isArray(first.content);
}

/** The .messages.json path for a given session path (meta or messages). */
function messagesPathFor(file: string, o: Record<string, unknown>): string | null {
  if (isMessages(o)) return file; // already the transcript
  const mp = str(o.messages_path);
  if (mp && existsSync(mp)) return mp;
  // Fall back to the sibling <id>.messages.json next to the meta file.
  const id = str(o.session_id);
  if (id) { const sib = join(file, "..", `${id}.messages.json`); if (existsSync(sib)) return sib; }
  return null;
}

/** The cwd a Cline session ran in (from the meta; messages files have none). */
export function clineSessionCwd(file: string): string | null {
  const o = safeJson(file);
  if (!o) return null;
  if (isMeta(o)) return str(o.cwd) ?? str(o.workspace_root) ?? null;
  // A messages file: find its sibling meta for the cwd.
  const id = str(o.sessionId);
  if (id) { const meta = safeJson(join(file, "..", `${id}.json`)); if (meta) return str(meta.cwd) ?? str(meta.workspace_root) ?? null; }
  return null;
}

/** True when this path is a Cline session we can read (meta or messages). */
export function clineFormatIsKnown(file: string): boolean {
  const o = safeJson(file);
  return !!o && (isMeta(o) || isMessages(o));
}

/** Every Cline session META file for this cwd, newest first. */
export function listClineSessions(cwd: string): string[] {
  const dir = sessionsDir();
  if (!existsSync(dir)) return [];
  const target = realpathOr(cwd);
  const found: { file: string; mtimeMs: number }[] = [];
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return []; }
  for (const name of entries) {
    const sessionDir = join(dir, name);
    const meta = join(sessionDir, `${name}.json`);
    if (!existsSync(meta)) continue;
    const o = safeJson(meta);
    if (!o || !isMeta(o)) continue;
    const c = str(o.cwd) ?? str(o.workspace_root);
    if (!c || realpathOr(c) !== target) continue;
    let mtimeMs = 0;
    try { mtimeMs = statSync(meta).mtimeMs; } catch { /* keep 0 */ }
    found.push({ file: meta, mtimeMs });
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return found.map((f) => f.file);
}

/** Map one message's content parts to neutral events. */
function partsToEvents(role: "user" | "assistant", content: unknown[], ts: string): TranscriptEvent[] {
  const out: TranscriptEvent[] = [];
  for (const raw of content) {
    const p = rec(raw);
    const type = str(p.type);
    if (type === "text") {
      const text = str(p.text);
      if (text) out.push({ role, kind: "text", text, timestamp: ts });
      continue;
    }
    if (type === "thinking") continue; // reasoning: ignored, not guessed at
    if (type === "tool_use") {
      const id = str(p.id);
      const name = str(p.name) ?? "";
      const input = rec(p.input);
      if (name === "read_files") {
        const files = arr(input.files).filter((f): f is string => typeof f === "string");
        out.push({ role: "assistant", kind: "tool_use", toolName: "Read", input: { file_path: files }, timestamp: ts, ...(id ? { toolUseId: id } : {}) });
      } else if (name === "run_commands") {
        const cmds = arr(input.commands).filter((c): c is string => typeof c === "string");
        cmds.forEach((command, k) => {
          out.push({ role: "assistant", kind: "tool_use", toolName: "Bash", input: { command }, timestamp: ts, ...(id ? { toolUseId: `${id}#${k}` } : {}) });
        });
      } else if (name === "editor") {
        const path = str(input.path);
        out.push({ role: "assistant", kind: "tool_use", toolName: "Edit", input: { file_path: path, old_string: input.old_text, new_string: input.new_text }, timestamp: ts, ...(id ? { toolUseId: id } : {}) });
      } else if (name === "ask_question") {
        const q = str(input.question);
        if (q) out.push({ role: "assistant", kind: "text", text: q, timestamp: ts });
      } else {
        out.push({ role: "assistant", kind: "tool_use", toolName: name || "tool", input, timestamp: ts, ...(id ? { toolUseId: id } : {}) });
      }
      continue;
    }
    if (type === "tool_result") {
      const id = str(p.tool_use_id);
      const name = str(p.name) ?? "";
      const body = p.content;
      if (name === "run_commands" && Array.isArray(body)) {
        body.forEach((r, k) => {
          const rr = rec(r);
          const result = str(rr.result) ?? "";
          const err = str(rr.error);
          const content = err ? `${result}\n[error] ${err}` : result;
          out.push({ role: "user", kind: "tool_result", content, isError: rr.success === false, timestamp: ts, ...(id ? { toolUseId: `${id}#${k}` } : {}) });
        });
      } else if (name === "ask_question") {
        // The chosen option string IS the user's answer. Emit it as user text so
        // the approval gate sees Cline's ask-user step (an authorised push reads
        // as Followed), mapped like Copilot's permission approval.
        const answer = typeof body === "string" ? body : str(rec(body).result);
        if (answer) out.push({ role: "user", kind: "text", text: answer, timestamp: ts });
      } else {
        // read_files / editor / other: one tool_result carrying a stringified body.
        let content = "";
        if (typeof body === "string") content = body;
        else if (Array.isArray(body)) content = body.map((r) => { const rr = rec(r); return str(rr.result) ?? str(rr.error) ?? ""; }).filter(Boolean).join("\n");
        else content = JSON.stringify(body ?? "");
        out.push({ role: "user", kind: "tool_result", content, isError: false, timestamp: ts, ...(id ? { toolUseId: id } : {}) });
      }
      continue;
    }
  }
  return out;
}

/** Parse a Cline session (meta file or messages file) into neutral events. */
export function parseClineTranscript(file: string): TranscriptEvent[] {
  const o = safeJson(file);
  if (!o) return [];
  const msgPath = messagesPathFor(file, o);
  if (!msgPath) return [];
  const mo = msgPath === file ? o : safeJson(msgPath);
  if (!mo) return [];
  const messages = arr(mo.messages);
  const events: TranscriptEvent[] = [];
  for (const raw of messages) {
    const m = rec(raw);
    const role = m.role === "assistant" ? "assistant" : m.role === "user" ? "user" : null;
    if (!role) continue;
    const ts = iso(m.ts);
    events.push(...partsToEvents(role, arr(m.content), ts));
  }
  return events;
}
