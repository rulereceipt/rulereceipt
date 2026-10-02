import { existsSync, readFileSync, readdirSync, statSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import type { TranscriptEvent } from "../types.js";

/**
 * OpenCode adapter — EXPERIMENTAL (no real-session fixtures yet).
 *
 * Reads the JSON file store (NOT the newer `opencode.db` SQLite, which is
 * deferred — see REUSE.md). Format documented by yigitkonur/cli-continues (MIT,
 * src/parsers/opencode.ts, pinned e486cd22a592d89d890cff056624647fbe9cbe80).
 * Credit: NOTICE.md / REUSE.md.
 *
 * Store (under `$XDG_DATA_HOME/opencode/storage` or `~/.local/share/opencode/
 * storage`): a 3-directory join
 *   session/<proj>/ses_*.json   → { id, projectID, directory, time:{updated} }
 *   message/<sessionId>/msg_*.json → { id, role }
 *   part/<messageId>/prt_*.json    → { type:'text'|'tool'|…, text?, tool?, callID?,
 *                                      state:{ input, status, output, error } }
 * cwd = session.directory, else project/<projectID>.json `.worktree`.
 *   text part  -> text (role of its message)
 *   tool part  -> tool_use (shell -> canonical Bash) + a tool_result from its state.
 *
 * The message/part dirs are resolved RELATIVE to the session file, so
 * `--transcript <…/session/<proj>/ses_X.json>` works wherever the store lives.
 *
 * RESILIENCE: only the fields above; unknown part types / bad files skipped,
 * never guessed; `openCodeFormatIsKnown` gates use.
 */

function realpathOr(p: string): string { try { return realpathSync(p); } catch { return p; } }
function str(v: unknown): string | undefined { return typeof v === "string" && v.length > 0 ? v : undefined; }
function rec(v: unknown): Record<string, unknown> { return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {}; }

function storageDir(): string {
  const xdg = process.env.XDG_DATA_HOME?.trim();
  const base = xdg && xdg.length > 0 ? join(xdg, "opencode") : join(homedir(), ".local", "share", "opencode");
  return join(base, "storage");
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

/** OpenCode session files for this cwd, newest first. */
export function listOpenCodeSessions(cwd: string): string[] {
  const storage = storageDir();
  if (!existsSync(storage)) return [];
  const target = realpathOr(cwd);
  const hits: { file: string; mtimeMs: number }[] = [];
  for (const file of listSessionJsonFiles(storage)) {
    const s = readJson(file);
    if (!s) continue;
    const c = sessionCwd(file, s);
    if (c && realpathOr(c) !== target) continue;
    try { hits.push({ file, mtimeMs: statSync(file).mtimeMs }); } catch { /* skip */ }
  }
  return hits.sort((a, b) => b.mtimeMs - a.mtimeMs).map((h) => h.file);
}

function sortedJson(dir: string): string[] {
  try { return readdirSync(dir).filter((f) => f.endsWith(".json")).sort(); } catch { return []; }
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

/** True when the file is an OpenCode session JSON (id starting `ses_`). */
export function openCodeFormatIsKnown(sessionFile: string): boolean {
  const s = readJson(sessionFile);
  return Boolean(s && str(s.id)?.startsWith("ses_"));
}

/** Parse one OpenCode session (by its ses_*.json) into neutral events. Tolerant. */
export function parseOpenCodeTranscript(sessionFile: string): TranscriptEvent[] {
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
      if (!part) continue;
      if (part.type === "text" && str(part.text)) {
        out.push({ role, kind: "text", text: part.text as string, timestamp: "" });
      } else if (part.type === "tool" && role === "assistant") {
        const name = str(part.tool);
        if (!name) continue;
        const state = rec(part.state);
        const id = str(part.callID);
        out.push(toToolUse(name, rec(state.input), id, ""));
        const content = str(state.output) ?? str(state.error) ?? "";
        out.push({ role: "user", kind: "tool_result", toolUseId: id, content: content.slice(0, 2000), isError: state.status === "error", timestamp: "" });
      }
    }
  }
  return out;
}
