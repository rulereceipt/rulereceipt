import { existsSync, readFileSync, readdirSync, statSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TranscriptEvent } from "../types.js";

/**
 * GitHub Copilot CLI adapter — EXPERIMENTAL (no real-session fixtures yet).
 *
 * Reader is OUR OWN code. The on-disk FORMAT is documented by
 * yigitkonur/cli-continues (MIT, src/parsers/copilot.ts, pinned commit
 * e486cd22a592d89d890cff056624647fbe9cbe80), which reverse-engineered it; we map
 * that format to our neutral events ourselves. Credit: see NOTICE.md and REUSE.md.
 *
 * Layout: ~/.copilot/session-state/<id>/ with `workspace.yaml` (holds `cwd`) and
 * `events.jsonl`. `COPILOT_HOME` overrides the root. Event `type`s we map:
 *   user.message            -> text (role user)        data.content / transformedContent
 *   assistant.message       -> text (role assistant)   data.content; data.toolRequests[] -> tool_use
 *   tool.execution_start    -> tool_use                data.toolName / toolCallId / arguments
 *   tool.execution_complete -> tool_result             data.toolCallId / success / result
 *
 * RESILIENCE (a format change must make us quieter, never wrong):
 *  - depend only on the fields above; ignore every unknown field;
 *  - a line that doesn't parse, or whose type we don't know, is skipped, never guessed;
 *  - `copilotFormatIsKnown` reports whether the file looked like a Copilot log at
 *    all, so a caller can say "format newer than tested" instead of fabricating.
 */

const KNOWN_TYPES = new Set([
  "user.message", "assistant.message", "tool.execution_start", "tool.execution_complete",
  "session.start", "session.shutdown",
]);

function copilotRoot(): string {
  const env = process.env.COPILOT_HOME?.trim();
  return env && env.length > 0 ? env : join(homedir(), ".copilot");
}

function realpathOr(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

/** `cwd:` out of a workspace.yaml, read by a line scan (no YAML dependency). */
function workspaceCwd(dir: string): string | null {
  try {
    for (const line of readFileSync(join(dir, "workspace.yaml"), "utf-8").split("\n")) {
      const m = line.match(/^\s*cwd\s*:\s*(.+?)\s*$/);
      if (m) return m[1].replace(/^["']|["']$/g, "");
    }
  } catch { /* unreadable */ }
  return null;
}

/** Copilot CLI session files (events.jsonl) for this cwd, newest first. */
export function listCopilotSessions(cwd: string): string[] {
  const base = join(copilotRoot(), "session-state");
  if (!existsSync(base)) return [];
  const target = realpathOr(cwd);
  const hits: { file: string; mtimeMs: number }[] = [];
  let entries: string[] = [];
  try { entries = readdirSync(base); } catch { return []; }
  for (const name of entries) {
    const dir = join(base, name);
    const events = join(dir, "events.jsonl");
    if (!existsSync(events)) continue;
    const wc = workspaceCwd(dir);
    if (wc && realpathOr(wc) !== target) continue; // belongs to another project
    try { hits.push({ file: events, mtimeMs: statSync(events).mtimeMs }); } catch { /* skip */ }
  }
  return hits.sort((a, b) => b.mtimeMs - a.mtimeMs).map((h) => h.file);
}

interface CopilotLine {
  type?: string;
  timestamp?: string;
  data?: {
    content?: unknown; transformedContent?: unknown;
    toolRequests?: { name?: string; args?: unknown; arguments?: unknown }[];
    toolName?: string; toolCallId?: string; arguments?: unknown;
    success?: boolean; result?: unknown;
  };
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Map one tool invocation (name + args) to our canonical tool_use input. */
function toToolUse(name: string, args: Record<string, unknown>, id: string | undefined, ts: string): TranscriptEvent {
  const command = str(args.command) ?? str(args.cmd);
  const filePath = str(args.path) ?? str(args.file_path) ?? str(args.filePath);
  const lower = name.toLowerCase();
  // A shell command → canonical Bash shape, so the command-scanning checks fire
  // on Copilot exactly as on Claude Code.
  if (command && (/(shell|bash|terminal|exec|run|command)/.test(lower) || !filePath)) {
    return { role: "assistant", kind: "tool_use", toolName: "Bash", toolUseId: id, input: { command }, timestamp: ts };
  }
  if (filePath && /(write|create|edit|replace|apply|patch|insert|modif)/.test(lower)) {
    return { role: "assistant", kind: "tool_use", toolName: lower.includes("edit") || lower.includes("replace") || lower.includes("patch") ? "Edit" : "Write", toolUseId: id, input: { file_path: filePath, ...args }, timestamp: ts };
  }
  if (filePath && /(read|view|open|cat|show)/.test(lower)) {
    return { role: "assistant", kind: "tool_use", toolName: "Read", toolUseId: id, input: { file_path: filePath }, timestamp: ts };
  }
  return { role: "assistant", kind: "tool_use", toolName: name, toolUseId: id, input: args, timestamp: ts };
}

/** True when the file looks like a Copilot CLI log at all (≥1 known event type). */
export function copilotFormatIsKnown(sessionFile: string): boolean {
  let raw: string;
  try { raw = readFileSync(sessionFile, "utf-8"); } catch { return false; }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const t = (JSON.parse(line) as CopilotLine).type;
      if (typeof t === "string" && KNOWN_TYPES.has(t)) return true;
    } catch { /* skip */ }
  }
  return false;
}

/** Parse a Copilot CLI events.jsonl into neutral events. Tolerant: unknown → skipped. */
export function parseCopilotTranscript(sessionFile: string): TranscriptEvent[] {
  let raw: string;
  try { raw = readFileSync(sessionFile, "utf-8"); } catch { return []; }
  const out: TranscriptEvent[] = [];
  const startNames = new Map<string, string>(); // toolCallId -> toolName
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let e: CopilotLine;
    try { e = JSON.parse(line) as CopilotLine; } catch { continue; }
    const ts = str(e.timestamp) ?? "";
    const d = e.data ?? {};
    switch (e.type) {
      case "user.message": {
        const text = str(d.content) ?? str(d.transformedContent);
        if (text) out.push({ role: "user", kind: "text", text, timestamp: ts });
        break;
      }
      case "assistant.message": {
        const text = typeof d.content === "string" ? d.content : d.content ? JSON.stringify(d.content) : undefined;
        if (text) out.push({ role: "assistant", kind: "text", text, timestamp: ts });
        for (const [i, tr] of (d.toolRequests ?? []).entries()) {
          const name = str(tr?.name);
          if (!name) continue;
          out.push(toToolUse(name, { ...asRecord(tr?.args), ...asRecord(tr?.arguments) }, `tr:${i}`, ts));
        }
        break;
      }
      case "tool.execution_start": {
        const name = str(d.toolName);
        if (!name) break;
        const id = str(d.toolCallId);
        if (id) startNames.set(id, name);
        out.push(toToolUse(name, asRecord(d.arguments), id, ts));
        break;
      }
      case "tool.execution_complete": {
        const id = str(d.toolCallId);
        const name = id ? startNames.get(id) : undefined;
        const r = d.result;
        const content = typeof r === "string" ? r : str(asRecord(r).content) ?? str(asRecord(r).detailedContent) ?? (r ? JSON.stringify(r).slice(0, 2000) : "");
        out.push({ role: "user", kind: "tool_result", toolUseId: id, content, isError: d.success === false, timestamp: ts, ...(name ? { toolName: name } : {}) } as TranscriptEvent);
        break;
      }
      default:
        break; // unknown type: ignore, never fabricate
    }
  }
  return out;
}
