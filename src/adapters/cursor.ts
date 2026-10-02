import { existsSync, readFileSync, readdirSync, statSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TranscriptEvent } from "../types.js";

/**
 * Cursor adapter — EXPERIMENTAL (no real-session fixtures yet).
 *
 * Reads the CURRENT Cursor agent-transcripts (JSONL, Anthropic-API shaped), not
 * the old `state.vscdb` SQLite. Format documented by yigitkonur/cli-continues
 * (MIT, src/parsers/cursor.ts, pinned e486cd22a592d89d890cff056624647fbe9cbe80).
 * Credit: NOTICE.md / REUSE.md. Read-only; never opens/locks state.vscdb.
 *
 * Storage: `~/.cursor/projects/<slug>/agent-transcripts/**​/*.jsonl` (nested
 * `<uuid>/transcript.jsonl` or flat `<uuid>.jsonl`). The project's cwd is in
 * `~/.cursor/projects/<slug>/repo.json` (`workspace` | `rootPath` | `path`).
 * Each JSONL line is `{ role:'user'|'assistant', content: [Anthropic blocks] }`:
 *   {type:'text',text}                         -> text
 *   {type:'tool_use',id,name,input}            -> tool_use (shell -> canonical Bash)
 *   {type:'tool_result',tool_use_id,content,is_error} -> tool_result
 *
 * DEFERRED: the legacy `state.vscdb` SQLite path (partial, reverse-engineered,
 * multi-migration) — it needs a WASM sqlite reader and is low-confidence without
 * real samples. Logged in REUSE.md.
 *
 * RESILIENCE: only the fields above; unknown blocks/lines skipped, never guessed;
 * `cursorFormatIsKnown` gates use so another tool's log is not mis-parsed.
 */

function cursorProjectsDir(): string {
  const env = process.env.CURSOR_HOME?.trim();
  return env && env.length > 0 ? join(env, "projects") : join(homedir(), ".cursor", "projects");
}
function realpathOr(p: string): string { try { return realpathSync(p); } catch { return p; } }
function str(v: unknown): string | undefined { return typeof v === "string" && v.length > 0 ? v : undefined; }
function rec(v: unknown): Record<string, unknown> { return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {}; }

/** The cwd a Cursor project dir maps to, from its repo.json. */
function projectCwd(projectDir: string): string | null {
  try {
    const o = JSON.parse(readFileSync(join(projectDir, "repo.json"), "utf-8")) as Record<string, unknown>;
    return str(o.workspace) ?? str(o.rootPath) ?? str(o.path) ?? null;
  } catch { return null; }
}

function jsonlFilesUnder(dir: string, out: string[], depth = 0): void {
  if (depth > 4 || !existsSync(dir)) return;
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    const p = join(dir, name);
    let isDir = false;
    try { isDir = statSync(p).isDirectory(); } catch { continue; }
    if (isDir) jsonlFilesUnder(p, out, depth + 1);
    else if (name.endsWith(".jsonl")) out.push(p);
  }
}

/** Cursor agent-transcript files for this cwd, newest first. */
export function listCursorSessions(cwd: string): string[] {
  const base = cursorProjectsDir();
  if (!existsSync(base)) return [];
  const target = realpathOr(cwd);
  let projects: string[] = [];
  try { projects = readdirSync(base); } catch { return []; }
  const hits: { file: string; mtimeMs: number }[] = [];
  for (const slug of projects) {
    const projectDir = join(base, slug);
    const mapped = projectCwd(projectDir);
    if (mapped && realpathOr(mapped) !== target) continue; // another project
    const files: string[] = [];
    jsonlFilesUnder(join(projectDir, "agent-transcripts"), files);
    for (const f of files) {
      try { hits.push({ file: f, mtimeMs: statSync(f).mtimeMs }); } catch { /* skip */ }
    }
  }
  return hits.sort((a, b) => b.mtimeMs - a.mtimeMs).map((h) => h.file);
}

function toToolUse(name: string, input: Record<string, unknown>, id: string | undefined, ts: string): TranscriptEvent {
  const command = str(input.command) ?? str(input.cmd);
  const filePath = str(input.file_path) ?? str(input.path) ?? str(input.target_file);
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

interface CursorLine { role?: string; content?: unknown; }

function toolResultContent(block: Record<string, unknown>): string {
  const c = block.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p) => str(rec(p).text) ?? "").filter(Boolean).join("\n");
  return c ? JSON.stringify(c).slice(0, 2000) : "";
}

/** True when a file looks like a Cursor agent-transcript (≥1 {role,content[]} line). */
export function cursorFormatIsKnown(file: string): boolean {
  let raw: string;
  try { raw = readFileSync(file, "utf-8"); } catch { return false; }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as CursorLine & { message?: unknown; type?: unknown };
      // A Cursor line has a top-level role + content array and NO Claude-style
      // `message` wrapper and NO Codex/Copilot `type`.
      if ((o.role === "user" || o.role === "assistant") && Array.isArray(o.content) && o.message === undefined && o.type === undefined) return true;
    } catch { /* skip */ }
    break; // only the first non-blank line decides
  }
  return false;
}

/** Parse a Cursor agent-transcript JSONL into neutral events. Tolerant. */
export function parseCursorTranscript(file: string): TranscriptEvent[] {
  let raw: string;
  try { raw = readFileSync(file, "utf-8"); } catch { return []; }
  const out: TranscriptEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let o: CursorLine;
    try { o = JSON.parse(line) as CursorLine; } catch { continue; }
    const role = o.role === "assistant" ? "assistant" : o.role === "user" ? "user" : undefined;
    if (!role || !Array.isArray(o.content)) continue;
    for (const raw2 of o.content as unknown[]) {
      const b = rec(raw2);
      if (b.type === "text" && str(b.text)) {
        out.push({ role, kind: "text", text: b.text as string, timestamp: "" });
      } else if (b.type === "tool_use" && role === "assistant") {
        const name = str(b.name);
        if (name) out.push(toToolUse(name, rec(b.input), str(b.id), ""));
      } else if (b.type === "tool_result") {
        out.push({ role: "user", kind: "tool_result", toolUseId: str(b.tool_use_id), content: toolResultContent(b), isError: b.is_error === true, timestamp: "" });
      }
    }
  }
  return out;
}
