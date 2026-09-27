import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TranscriptEvent } from "../types.js";

/**
 * OpenAI Codex CLI session adapter.
 *
 * Format VERIFIED 2026-09-26 against the openai/codex repo, a real v0.130.0
 * rollout dump (dev.to/milkoor reverse-engineering write-up), and a
 * third-party Go parser struct — NOT assumed. But OpenAI publishes no schema
 * and the on-disk shape has changed across versions (open request openai/codex
 * #2288 for a stable trajectory format), so parsing here is deliberately
 * TOLERANT: an unknown line type or field is ignored, never a crash and never
 * a fabricated event. Same fail-closed discipline as the Claude parser.
 *
 *   Path (GLOBAL, date-partitioned — not per-project):
 *     ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
 *   Line 1 is a `session_meta` record whose payload.cwd names the project the
 *   session ran in — that is how a global store is filtered to one project.
 *   Every other line is `{timestamp, type, payload}`; the transcript lives in
 *   `type:"response_item"` lines, discriminated by `payload.type`:
 *     - message            -> text (role user/developer/system/assistant)
 *     - function_call /     -> tool_use  (name, arguments JSON string, call_id)
 *       local_shell_call /
 *       custom_tool_call
 *     - function_call_output-> tool_result (call_id, output)
 *   `reasoning`, `event_msg`, `turn_context`, `compacted` etc. are ignored.
 *
 * NOT YET tested against a real session file on THIS machine — until it is,
 * this is not advertised as supported on the site/README (see adapters/index).
 */

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    // Take `.text` from any part regardless of its inner type
    // (input_text / output_text / text) — the inner-type names are the one
    // thing not confirmed against a real user line, so we do not rely on them.
    return content
      .map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (output && typeof output === "object") {
    const o = output as { output?: unknown; content?: unknown; text?: unknown };
    if (typeof o.output === "string") return o.output;
    if (typeof o.text === "string") return o.text;
    if (typeof o.content === "string") return o.content;
    try {
      return JSON.stringify(output);
    } catch {
      return "";
    }
  }
  return "";
}

/** Best-effort error detection from a tool result, without fabricating one. */
function outputIsError(output: unknown): boolean {
  if (output && typeof output === "object") {
    const o = output as Record<string, unknown>;
    const meta = o.metadata as Record<string, unknown> | undefined;
    const exit = (o.exit_code ?? meta?.exit_code) as unknown;
    if (typeof exit === "number") return exit !== 0;
    if (o.success === false) return true;
  }
  return false;
}

export function parseCodexLine(line: string): TranscriptEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
  const obj = parsed as Record<string, unknown>;
  if (obj.type !== "response_item") return [];
  const payload = obj.payload;
  if (typeof payload !== "object" || payload === null) return [];
  const p = payload as Record<string, unknown>;
  const timestamp = typeof obj.timestamp === "string" ? obj.timestamp : "";

  if (p.type === "message") {
    const text = textFromContent(p.content);
    if (!text) return [];
    const role = p.role === "assistant" ? "assistant" : "user";
    return [{ role, kind: "text", text, timestamp }];
  }

  if (p.type === "function_call" || p.type === "local_shell_call" || p.type === "custom_tool_call") {
    const toolName =
      typeof p.name === "string" ? p.name : p.type === "local_shell_call" ? "shell" : "tool";
    // `arguments` is a JSON string in Codex; keep it parsed when possible so
    // the checks see structured input, else fall back to the raw value.
    let input: unknown = p.arguments ?? p.input ?? p.action ?? {};
    if (typeof input === "string") {
      try {
        input = JSON.parse(input);
      } catch {
        /* leave as the raw string */
      }
    }
    return [
      {
        role: "assistant",
        kind: "tool_use",
        toolName,
        input,
        timestamp,
        toolUseId: typeof p.call_id === "string" ? p.call_id : undefined,
      },
    ];
  }

  if (p.type === "function_call_output" || p.type === "custom_tool_call_output" || p.type === "local_shell_call_output") {
    return [
      {
        role: "user",
        kind: "tool_result",
        content: outputText(p.output),
        isError: outputIsError(p.output),
        timestamp,
        toolUseId: typeof p.call_id === "string" ? p.call_id : undefined,
      },
    ];
  }

  return []; // reasoning, unknown payload types: ignored, not guessed at
}

export function parseCodexTranscript(filePath: string): TranscriptEvent[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }
  const events: TranscriptEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    events.push(...parseCodexLine(line));
  }
  return events;
}

/** The cwd a rollout file was recorded in, from its first `session_meta` line. */
function sessionCwd(filePath: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
  const firstLine = raw.split("\n", 1)[0];
  if (!firstLine) return null;
  try {
    const obj = JSON.parse(firstLine) as Record<string, unknown>;
    if (obj.type !== "session_meta") return null;
    const payload = obj.payload as Record<string, unknown> | undefined;
    const cwd = payload?.cwd;
    return typeof cwd === "string" ? cwd : null;
  } catch {
    return null;
  }
}

// Resolved at call time, not module load, so the home dir is read live.
function codexSessionsRoot(): string {
  return join(homedir(), ".codex", "sessions");
}

/** Recursively collect rollout-*.jsonl files under the date-partitioned tree. */
function collectRolloutFiles(dir: string, out: string[]): void {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectRolloutFiles(full, out);
    else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) out.push(full);
  }
}

/** Every Codex session recorded for this cwd, newest first. */
export function listCodexSessions(cwd: string): string[] {
  const all: string[] = [];
  collectRolloutFiles(codexSessionsRoot(), all);
  return all
    .filter((f) => sessionCwd(f) === cwd)
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}
