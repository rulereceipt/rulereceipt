import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TranscriptEvent } from "../types.js";

/**
 * Antigravity CLI adapter (Google's agent that replaced the old Gemini CLI).
 *
 * Storage: ~/.gemini/antigravity-cli/brain/<conversation-id>/.system_generated/
 *   logs/transcript.jsonl        — the record we read (== transcript_full.jsonl)
 *   logs/chunks/…                — per-chunk copies (same content)
 *   steps/<n>/output.txt         — raw command outputs
 * We read ONLY transcript.jsonl; never the chunks, steps, or anything outside
 * the brain folder (no auth/keyring/browser state).
 *
 * Line shape `{type, content, source, status, step_index, created_at, …}`:
 *   USER_INPUT        -> user text   (content wrapped in <USER_REQUEST>…</USER_REQUEST>)
 *   PLANNER_RESPONSE  -> assistant text (content, when non-null) + tool_calls[]
 *                        run_command        -> Bash   (args.CommandLine)
 *                        view_file          -> Read   (args.AbsolutePath)
 *                        replace_file_content -> Edit  (args.TargetFile)
 *   GENERIC           -> tool_result (content is the command output text)
 * Tool-call arg VALUES are JSON-string-encoded (e.g. "\"ls -la\""), so unwrap once.
 */

function str(v: unknown): string | undefined { return typeof v === "string" && v.length > 0 ? v : undefined; }
function rec(v: unknown): Record<string, unknown> { return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {}; }

/** Antigravity encodes each tool-call arg value as a JSON string literal; unwrap it. */
function unwrap(v: unknown): string {
  if (typeof v !== "string") return "";
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try { return JSON.parse(v) as string; } catch { return v.slice(1, -1); }
  }
  return v;
}

function brainRoot(): string {
  return join(homedir(), ".gemini", "antigravity-cli", "brain");
}

/** The cwd a conversation ran in — read from the first run_command's Cwd arg. */
export function antigravitySessionCwd(file: string): string | null {
  let raw: string;
  try { raw = readFileSync(file, "utf-8"); } catch { return null; }
  for (const line of raw.split("\n")) {
    if (!line.includes("run_command")) continue;
    try {
      const o = JSON.parse(line) as { tool_calls?: { name?: string; args?: Record<string, unknown> }[] };
      for (const tc of o.tool_calls ?? []) {
        if (tc?.name === "run_command") {
          const cwd = unwrap(tc.args?.Cwd);
          if (cwd) return cwd;
        }
      }
    } catch { /* skip */ }
  }
  return null;
}

/** Antigravity conversation transcripts for this cwd, newest first. */
export function listAntigravitySessions(cwd: string): string[] {
  const base = brainRoot();
  if (!existsSync(base)) return [];
  const hits: { file: string; mtimeMs: number }[] = [];
  let ids: string[] = [];
  try { ids = readdirSync(base); } catch { return []; }
  for (const id of ids) {
    const f = join(base, id, ".system_generated", "logs", "transcript.jsonl");
    if (!existsSync(f)) continue;
    // Only include a session we can CONFIRM belongs to this cwd.
    if (antigravitySessionCwd(f) !== cwd) continue;
    try { hits.push({ file: f, mtimeMs: statSync(f).mtimeMs }); } catch { /* skip */ }
  }
  return hits.sort((a, b) => b.mtimeMs - a.mtimeMs).map((h) => h.file);
}

function mapToolCall(name: string, args: Record<string, unknown>, ts: string): TranscriptEvent | null {
  if (name === "run_command") {
    const command = unwrap(args.CommandLine);
    return command ? { role: "assistant", kind: "tool_use", toolName: "Bash", input: { command }, timestamp: ts } : null;
  }
  if (name === "view_file") {
    const file_path = unwrap(args.AbsolutePath);
    return file_path ? { role: "assistant", kind: "tool_use", toolName: "Read", input: { file_path }, timestamp: ts } : null;
  }
  if (name === "replace_file_content" || name === "write_file" || name === "create_file") {
    const file_path = unwrap(args.TargetFile) || unwrap(args.AbsolutePath);
    return file_path ? { role: "assistant", kind: "tool_use", toolName: name === "replace_file_content" ? "Edit" : "Write", input: { file_path }, timestamp: ts } : null;
  }
  return null; // unknown tool: ignored, never guessed at
}

/** True when a file looks like an Antigravity transcript (≥1 known event type). */
export function antigravityFormatIsKnown(file: string): boolean {
  let raw: string;
  try { raw = readFileSync(file, "utf-8"); } catch { return false; }
  let seen = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const t = (JSON.parse(line) as { type?: unknown }).type;
      if (t === "PLANNER_RESPONSE" || t === "USER_INPUT" || t === "GENERIC") return true;
    } catch { /* skip */ }
    if (++seen >= 10) break;
  }
  return false;
}

/** Parse an Antigravity transcript.jsonl into neutral events. Tolerant. */
export function parseAntigravityTranscript(file: string): TranscriptEvent[] {
  let raw: string;
  try { raw = readFileSync(file, "utf-8"); } catch { return []; }
  const out: TranscriptEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let o: Record<string, unknown>;
    try { o = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const ts = str(o.created_at) ?? "";
    if (o.type === "USER_INPUT") {
      const c = str(o.content) ?? "";
      const m = c.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
      const text = (m ? m[1] : c).trim();
      if (text) out.push({ role: "user", kind: "text", text, timestamp: ts });
    } else if (o.type === "PLANNER_RESPONSE") {
      const text = str(o.content);
      if (text) out.push({ role: "assistant", kind: "text", text, timestamp: ts });
      for (const tc of (Array.isArray(o.tool_calls) ? o.tool_calls : []) as unknown[]) {
        const t = rec(tc);
        const name = str(t.name);
        if (!name) continue;
        const ev = mapToolCall(name, rec(t.args), ts);
        if (ev) out.push(ev);
      }
    } else if (o.type === "GENERIC") {
      // The command output / tool result, as a text blob.
      const c = str(o.content);
      if (c) out.push({ role: "user", kind: "tool_result", content: c, isError: false, timestamp: ts });
    }
  }
  return out;
}
