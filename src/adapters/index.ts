import { statSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import type { TranscriptEvent } from "../types.js";
import { listAllSessionFiles, readTranscriptFromFile, findSubagentFiles } from "../parsers/transcriptParser.js";
import { listCodexSessions, parseCodexTranscript } from "./codex.js";

/**
 * A session adapter turns one coding agent's on-disk session log into the
 * neutral TranscriptEvent[] the rule engine (classify.ts / the checks) already
 * runs on. The engine is agent-agnostic — it only ever sees text / tool_use /
 * tool_result — so generalising the tool to new agents is entirely a matter of
 * adding adapters here; nothing downstream changes.
 *
 * Only adapters that have been VERIFIED against a real format are `supported`.
 * The rest are listed as honest stubs (see UNSUPPORTED_TOOLS) so the tool can
 * say what it does and does NOT read, rather than silently missing sessions or
 * pretending to support a format it has not parsed.
 */
export interface SessionAdapter {
  /** Stable tool id, e.g. "claude-code", "codex". */
  tool: string;
  /** Every session file for this cwd, newest first (empty when the tool is absent). */
  listSessions(cwd: string): string[];
  /** Parse one session file into neutral events. */
  parse(sessionFile: string): TranscriptEvent[];
}

/**
 * Claude Code — the original and reference adapter. Delegates to the existing
 * transcriptParser so its behaviour (including subagent transcripts) is
 * unchanged: for a Claude-only machine the registry picks exactly the file and
 * events it always did.
 */
export const claudeCodeAdapter: SessionAdapter = {
  tool: "claude-code",
  listSessions: (cwd) => listAllSessionFiles(cwd),
  parse: (sessionFile) => {
    const events = readTranscriptFromFile(sessionFile);
    for (const sub of findSubagentFiles(sessionFile)) events.push(...readTranscriptFromFile(sub));
    return events;
  },
};

/** OpenAI Codex CLI — format verified, parsing tolerant. See adapters/codex.ts. */
export const codexAdapter: SessionAdapter = {
  tool: "codex",
  listSessions: (cwd) => listCodexSessions(cwd),
  parse: (sessionFile) => parseCodexTranscript(sessionFile),
};

/** Every adapter with a verified, tested-buildable parser. */
export const ADAPTERS: SessionAdapter[] = [claudeCodeAdapter, codexAdapter];

/**
 * Tools deliberately NOT read yet, with the honest reason. Kept as data (not
 * silence) so the tool — and its docs — can state exactly where the line is
 * and why, and so adding one later is a visible change here.
 */
export const UNSUPPORTED_TOOLS: { tool: string; reason: string }[] = [
  { tool: "gemini-cli", reason: "session-log path is known (~/.gemini/tmp/<hash>/chats/*.json) but the per-line JSON schema is unverified — not parsed, to avoid fabricating events" },
  { tool: "aider", reason: "history is a Markdown transcript (.aider.chat.history.md), not structured events — needs a prose parser, not a field mapping" },
  { tool: "opencode", reason: "stores sessions in a SQLite DB (opencode.db) since v1.2.0 (per-record JSON before) — needs a SQLite reader, version-dependent" },
  { tool: "cursor", reason: "IDE-embedded; chat history lives in undocumented internal state that changes across Cursor versions — real ongoing maintenance, out of scope for this pass" },
  { tool: "github-copilot", reason: "IDE-embedded; no accessible, stable local session log a third-party CLI can read" },
  { tool: "windsurf", reason: "IDE-embedded; history in undocumented internal state, same as Cursor" },
];

export interface LatestSession {
  adapter: SessionAdapter;
  file: string;
  mtimeMs: number;
}

/**
 * The single most recently modified session across ALL supported tools for
 * this cwd — the same "newest wins" rule the Claude reader already uses across
 * `.claude` vs `.claude-office`, now extended across tools. Returns null only
 * when no supported tool has a session for this project (the caller then asks
 * or reports "no session found").
 */
export function findLatestSession(cwd: string): LatestSession | null {
  let best: LatestSession | null = null;
  for (const adapter of ADAPTERS) {
    const files = adapter.listSessions(cwd); // newest first
    if (files.length === 0) continue;
    const file = files[0];
    let mtimeMs: number;
    try {
      mtimeMs = statSync(file).mtimeMs;
    } catch {
      continue;
    }
    if (!best || mtimeMs > best.mtimeMs) best = { adapter, file, mtimeMs };
  }
  return best;
}

/** Events from the latest session across all tools (empty when none exists). */
export function readLatestSessionEvents(cwd: string): TranscriptEvent[] {
  const latest = findLatestSession(cwd);
  return latest ? latest.adapter.parse(latest.file) : [];
}

/**
 * EVERY session across all supported tools for this cwd, newest first, each
 * paired with the adapter that can parse it. Used by the multi-session
 * compliance report so it audits Codex sessions alongside Claude ones, not
 * just Claude Code's.
 */
export function listAllSessions(cwd: string): { adapter: SessionAdapter; file: string }[] {
  const pairs: { adapter: SessionAdapter; file: string; mtimeMs: number }[] = [];
  for (const adapter of ADAPTERS) {
    for (const file of adapter.listSessions(cwd)) {
      try {
        pairs.push({ adapter, file, mtimeMs: statSync(file).mtimeMs });
      } catch {
        /* unreadable file: skip */
      }
    }
  }
  pairs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return pairs.map(({ adapter, file }) => ({ adapter, file }));
}

/**
 * Parse a single session file whose tool is not known ahead of time (a
 * `--transcript <file>` the user pointed at directly). A Codex rollout opens
 * with a `session_meta` or `response_item` line; anything else is read as a
 * Claude transcript. Sniffing the first line beats guessing from the path,
 * and it fails closed — an unreadable or unrecognised file yields no events,
 * never a wrong parse presented as right.
 */
export function parseSessionFile(file: string): TranscriptEvent[] {
  let raw: string;
  try {
    raw = readFileSync(file, "utf-8");
  } catch {
    return [];
  }
  const firstLine = raw.split("\n").find((l) => l.trim()) ?? "";
  try {
    const obj = JSON.parse(firstLine) as { type?: unknown };
    if (obj && typeof obj === "object" && (obj.type === "session_meta" || obj.type === "response_item")) {
      return parseCodexTranscript(file);
    }
  } catch {
    /* first line is not JSON: treat as a Claude transcript below */
  }
  return readTranscriptFromFile(file);
}

/**
 * A one-line note naming the tool a session came from, when it is NOT the
 * default Claude Code — so a user running `check` in a Codex project sees that
 * the report is about their Codex session, not silently. Null for Claude Code
 * (the default) and when there is no session.
 */
export function sessionSourceNote(cwd: string): string | null {
  const latest = findLatestSession(cwd);
  if (!latest || latest.adapter.tool === "claude-code") return null;
  return `Read a ${latest.adapter.tool} session (${basename(latest.file)}) — the most recently modified session found for this project.`;
}
