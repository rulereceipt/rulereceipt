import { existsSync, readFileSync, readdirSync, statSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TranscriptEvent } from "../types.js";

/**
 * Gemini CLI adapter — EXPERIMENTAL (no real-session fixtures yet).
 *
 * Reader is OUR OWN code; the FORMAT is documented by yigitkonur/cli-continues
 * (MIT, src/parsers/gemini.ts, pinned e486cd22a592d89d890cff056624647fbe9cbe80,
 * reverse-engineered from Pilan-AI/mnemo MIT). Credit: NOTICE.md / REUSE.md.
 *
 * Storage: `~/.gemini/tmp/<project-hash>/chats/*.{jsonl,json}` (current) and
 * `~/.gemini/sessions/*.json` (legacy). `GEMINI_HOME`/`HOME` set the root. The
 * project-hash → cwd map is `~/.gemini/projects.json` ({ projects: { <cwd>:
 * <id> } }); we also match by a session's own absolute tool paths as a fallback.
 *
 * A session is `{ messages: [...] }` (single JSON) or one record per JSONL line
 * that accretes into that array. Each message: `{ type: 'user'|'gemini'|'info',
 * content?, toolCalls?: [{ name, args:{command?,file_path?,path?}, status?,
 * result?:[{functionResponse:{response:{output?,error?}}}], resultDisplay? }] }`.
 *   user    -> text (user)
 *   gemini  -> text (assistant); each toolCall -> tool_use (shell -> canonical
 *              Bash) + a tool_result from its response/status.
 *
 * RESILIENCE: depend only on those fields; ignore unknown; a bad line/record is
 * skipped, never guessed. `geminiFormatIsKnown` gates use so a non-Gemini file
 * is never mis-parsed.
 */

function geminiRoot(): string {
  const env = process.env.GEMINI_HOME?.trim();
  return env && env.length > 0 ? join(env, ".gemini") : join(homedir(), ".gemini");
}
function realpathOr(p: string): string { try { return realpathSync(p); } catch { return p; } }
function str(v: unknown): string | undefined { return typeof v === "string" && v.length > 0 ? v : undefined; }
function rec(v: unknown): Record<string, unknown> { return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {}; }

interface GeminiTool { name?: string; args?: Record<string, unknown>; status?: string; result?: unknown; resultDisplay?: unknown; }
interface GeminiMsg { type?: string; content?: unknown; toolCalls?: GeminiTool[]; }

/** project-hash → cwd, from ~/.gemini/projects.json ({projects:{<cwd>:<id>}}). */
function projectHashToCwd(): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const parsed = JSON.parse(readFileSync(join(geminiRoot(), "projects.json"), "utf-8")) as { projects?: Record<string, string> };
    for (const [cwd, id] of Object.entries(parsed.projects ?? {})) out.set(id, cwd);
  } catch { /* absent */ }
  return out;
}

function sessionFilesIn(dir: string): string[] {
  const out: string[] = [];
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return out; }
  for (const n of names) if (n.endsWith(".jsonl") || n.endsWith(".json")) out.push(join(dir, n));
  return out;
}

/** Gemini CLI session files for this cwd, newest first. */
export function listGeminiSessions(cwd: string): string[] {
  const root = geminiRoot();
  const target = realpathOr(cwd);
  const hashCwd = projectHashToCwd();
  const candidates: string[] = [];
  const tmp = join(root, "tmp");
  if (existsSync(tmp)) {
    let hashes: string[] = [];
    try { hashes = readdirSync(tmp); } catch { hashes = []; }
    for (const h of hashes) {
      const mapped = hashCwd.get(h);
      // Only this project's hash dir when we can resolve it; when projects.json
      // doesn't map it, fall back to per-file cwd inference below.
      if (mapped && realpathOr(mapped) !== target) continue;
      candidates.push(...sessionFilesIn(join(tmp, h, "chats")));
    }
  }
  const legacy = join(root, "sessions");
  if (existsSync(legacy)) candidates.push(...sessionFilesIn(legacy));

  const hits: { file: string; mtimeMs: number }[] = [];
  for (const file of candidates) {
    try {
      // When the hash wasn't in projects.json, confirm by the session's own
      // absolute tool paths before claiming it for this cwd.
      if (!fileBelongsToCwd(file, target, hashCwd)) continue;
      hits.push({ file, mtimeMs: statSync(file).mtimeMs });
    } catch { /* skip */ }
  }
  return hits.sort((a, b) => b.mtimeMs - a.mtimeMs).map((h) => h.file);
}

/** True if a session file is for `target` cwd (by inferred absolute tool paths). */
function fileBelongsToCwd(file: string, target: string, hashCwd: Map<string, string>): boolean {
  // If its hash dir mapped to a cwd, listGeminiSessions already filtered it.
  if (hashCwd.size > 0) return true; // mapping-authoritative path handled above
  for (const m of readGeminiMessages(file)) {
    for (const tc of m.toolCalls ?? []) {
      const p = str(rec(tc.args).file_path) ?? str(rec(tc.args).path);
      if (p && p.startsWith("/")) return realpathOr(p).startsWith(target);
    }
  }
  return true; // no evidence either way: don't exclude (experimental, best-effort)
}

/** Messages from a Gemini session file, whether single-JSON or JSONL. Tolerant. */
function readGeminiMessages(file: string): GeminiMsg[] {
  let raw: string;
  try { raw = readFileSync(file, "utf-8"); } catch { return []; }
  // Single JSON object with a messages array?
  try {
    const obj = JSON.parse(raw) as { messages?: unknown };
    if (obj && Array.isArray(obj.messages)) return obj.messages as GeminiMsg[];
  } catch { /* not a single JSON: try JSONL */ }
  const msgs: GeminiMsg[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as GeminiMsg & { message?: GeminiMsg; messages?: GeminiMsg[] };
      if (Array.isArray(r.messages)) { msgs.push(...r.messages); continue; }
      const m = (r.message ?? r) as GeminiMsg;
      if (typeof m.type === "string") msgs.push(m);
    } catch { /* skip bad line */ }
  }
  return msgs;
}

function contentText(content: unknown): string | undefined {
  if (typeof content === "string") return content || undefined;
  if (Array.isArray(content)) {
    const parts = content.map((p) => (typeof p === "string" ? p : str(rec(p).text))).filter((p): p is string => Boolean(p));
    return parts.length ? parts.join("\n") : undefined;
  }
  return content ? JSON.stringify(content).slice(0, 2000) : undefined;
}

function toToolUse(name: string, args: Record<string, unknown>, id: string, ts: string): TranscriptEvent {
  const command = str(args.command) ?? str(args.cmd);
  const filePath = str(args.file_path) ?? str(args.path);
  const lower = name.toLowerCase();
  if (command && (/(shell|bash|terminal|exec|run|command)/.test(lower) || !filePath)) {
    return { role: "assistant", kind: "tool_use", toolName: "Bash", toolUseId: id, input: { command }, timestamp: ts };
  }
  if (filePath && /(write|create|edit|replace|patch|insert|modif)/.test(lower)) {
    return { role: "assistant", kind: "tool_use", toolName: /(edit|replace|patch)/.test(lower) ? "Edit" : "Write", toolUseId: id, input: { file_path: filePath, ...args }, timestamp: ts };
  }
  if (filePath && /(read|view|open|cat|show)/.test(lower)) {
    return { role: "assistant", kind: "tool_use", toolName: "Read", toolUseId: id, input: { file_path: filePath }, timestamp: ts };
  }
  return { role: "assistant", kind: "tool_use", toolName: name, toolUseId: id, input: args, timestamp: ts };
}

function toolResultText(tc: GeminiTool): { content: string; isError: boolean } {
  const first = Array.isArray(tc.result) ? (tc.result as unknown[])[0] : undefined;
  const resp = rec(rec(rec(first).functionResponse).response);
  const out = str(resp.output);
  const err = str(resp.error);
  const display = typeof tc.resultDisplay === "string" ? tc.resultDisplay : str(rec(tc.resultDisplay).fileDiff) ?? str(rec(tc.resultDisplay).newContent);
  return { content: (out ?? err ?? display ?? "").slice(0, 2000), isError: tc.status === "error" || Boolean(err) };
}

/** True when the file looks like a Gemini CLI session (≥1 user/gemini message). */
export function geminiFormatIsKnown(file: string): boolean {
  for (const m of readGeminiMessages(file)) {
    if (m.type === "gemini" || (m.type === "user" && m.content !== undefined)) return true;
  }
  return false;
}

/** Parse a Gemini CLI session into neutral events. Tolerant: unknown → skipped. */
export function parseGeminiTranscript(file: string): TranscriptEvent[] {
  const out: TranscriptEvent[] = [];
  let i = 0;
  for (const m of readGeminiMessages(file)) {
    if (m.type === "user") {
      const text = contentText(m.content);
      if (text) out.push({ role: "user", kind: "text", text, timestamp: "" });
    } else if (m.type === "gemini") {
      const text = contentText(m.content);
      if (text) out.push({ role: "assistant", kind: "text", text, timestamp: "" });
      for (const tc of m.toolCalls ?? []) {
        const name = str(tc.name);
        if (!name) continue;
        const id = `g:${i++}`;
        out.push(toToolUse(name, rec(tc.args), id, ""));
        const { content, isError } = toolResultText(tc);
        out.push({ role: "user", kind: "tool_result", toolUseId: id, content, isError, timestamp: "" });
      }
    }
  }
  return out;
}
