import { statSync } from "node:fs";
import { relative } from "node:path";
import { listAllSessions } from "./adapters/index.js";
import { redact } from "./wrong.js";
import type { TranscriptEvent } from "./types.js";

/**
 * `rulereceipt check --list-sessions` — a readable list of recent sessions so
 * `--transcript <path>` is easy to pick. Without this, choosing a session means
 * staring at a directory of UUID filenames. Each row shows the tool, how long
 * ago, the first thing the user said (truncated and redacted), and the path to
 * pass to `--transcript`.
 */

export interface SessionRow {
  file: string;
  tool: string;
  mtimeMs: number;
  firstPrompt: string;
}

function firstUserText(events: TranscriptEvent[]): string {
  for (const e of events) {
    if (e.kind === "text" && e.role === "user" && e.text.trim()) return e.text.trim();
  }
  return "";
}

const toolLabel = (t: string) => (t === "claude-code" ? "Claude Code" : t === "codex" ? "Codex" : t);

export function listSessionRows(cwd: string, limit = 15, sessions = listAllSessions(cwd)): SessionRow[] {
  const rows: SessionRow[] = [];
  for (const { adapter, file } of sessions.slice(0, limit)) {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(file).mtimeMs;
    } catch {
      continue;
    }
    let prompt = "";
    try {
      prompt = firstUserText(adapter.parse(file));
    } catch {
      /* unreadable session: still list it, just without a prompt */
    }
    rows.push({ file, tool: adapter.tool, mtimeMs, firstPrompt: redact(prompt).replace(/\s+/g, " ").trim().slice(0, 70) });
  }
  return rows;
}

function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 90) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function renderSessionList(rows: SessionRow[], cwd: string, now = Date.now()): string {
  if (rows.length === 0) {
    return "No coding-agent sessions found for this project. Run Claude Code (or Codex) here first.";
  }
  const out: string[] = [];
  out.push(`Recent sessions for this project (newest first). Check one with:  rulereceipt check --transcript <path>`);
  out.push("");
  rows.forEach((r, i) => {
    const rel = relative(cwd, r.file);
    const path = rel && !rel.startsWith("..") ? rel : r.file;
    out.push(`  ${String(i + 1).padStart(2)}. ${toolLabel(r.tool).padEnd(11)} ${ago(r.mtimeMs, now).padEnd(8)} ${r.firstPrompt || "(no user message)"}`);
    out.push(`      ${path}`);
  });
  return out.join("\n");
}
