import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TranscriptEvent } from "../types.js";

/**
 * Claude Code stores each session as a JSONL file at:
 *   ~/.claude/projects/<cwd with every "/" replaced by "-">/<sessionId>.jsonl
 * Verified directly against real session files, not assumed:
 * - top-level entries have a "type" field: mode, permission-mode,
 *   attachment, ai-title, system, last-prompt, file-history-snapshot,
 *   queue-operation, "user", "assistant" — only the last two matter here.
 * - assistant message.content is an array of blocks: "text", "thinking",
 *   "tool_use" ({id, name, input}).
 * - user message.content is either a plain string (the user's own typed
 *   message) or an array of blocks: "tool_result" ({tool_use_id, content,
 *   is_error}), "image".
 * - some assistant entries are API error stubs (isApiErrorMessage: true)
 *   with no real content — skip these.
 */

function encodeProjectPath(cwd: string): string {
  return cwd.replace(/\//g, "-");
}

function findLatestSessionFile(cwd: string): string | null {
  const projectDir = join(homedir(), ".claude", "projects", encodeProjectPath(cwd));
  let entries: string[];
  try {
    entries = readdirSync(projectDir);
  } catch {
    return null;
  }

  const sessionFiles = entries
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => join(projectDir, name))
    .filter((path) => {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    });

  if (sessionFiles.length === 0) return null;

  sessionFiles.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return sessionFiles[0];
}

function extractToolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "object" && part && "text" in part ? String((part as { text: unknown }).text) : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function parseLine(line: string): TranscriptEvent[] {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line);
  } catch {
    return [];
  }

  const timestamp = typeof obj.timestamp === "string" ? obj.timestamp : "";
  const events: TranscriptEvent[] = [];

  if (obj.type === "assistant" && !obj.isApiErrorMessage) {
    const message = obj.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (typeof block !== "object" || block === null) continue;
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") {
          events.push({ role: "assistant", kind: "text", text: b.text, timestamp });
        } else if (b.type === "tool_use" && typeof b.name === "string") {
          events.push({ role: "assistant", kind: "tool_use", toolName: b.name, input: b.input, timestamp });
        }
      }
    }
  } else if (obj.type === "user") {
    const message = obj.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (typeof content === "string") {
      events.push({ role: "user", kind: "text", text: content, timestamp });
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (typeof block !== "object" || block === null) continue;
        const b = block as Record<string, unknown>;
        if (b.type === "tool_result") {
          events.push({
            role: "user",
            kind: "tool_result",
            content: extractToolResultText(b.content),
            isError: b.is_error === true,
            timestamp,
          });
        }
      }
    }
  }

  return events;
}

/**
 * Read the most recently modified session transcript for a project
 * directory. Returns an empty array (not an error) if no session exists
 * yet or the project has never run Claude Code — that's a valid state,
 * not a failure.
 */
export function readLatestTranscript(cwd: string): TranscriptEvent[] {
  const filePath = findLatestSessionFile(cwd);
  if (!filePath) return [];

  const raw = readFileSync(filePath, "utf-8");
  const events: TranscriptEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    events.push(...parseLine(line));
  }
  return events;
}
