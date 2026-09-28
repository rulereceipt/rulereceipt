import type { TranscriptEvent } from "../types.js";

/**
 * The pure, Node-free half of transcript parsing: one JSONL line → events.
 *
 * Extracted from transcriptParser.ts 2026-09-28 so the browser demo can parse a
 * dropped session file client-side, with the SAME logic as the CLI and no
 * filesystem dependency. The site's "your file never leaves this page" claim
 * depends on everything reachable from here being pure string work — keep it
 * that way (no node: imports, no network, no storage).
 */

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

export function parseLine(line: string): TranscriptEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }

  // JSON.parse accepts any valid JSON value, not just objects — "null", "42",
  // "\"a string\"" all parse without throwing. A transcript line is only ever
  // meaningful as an object; anything else is skipped, not a crash.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return [];
  }
  const obj = parsed as Record<string, unknown>;

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
          events.push({ role: "assistant", kind: "tool_use", toolName: b.name, input: b.input, timestamp, toolUseId: typeof b.id === "string" ? b.id : undefined });
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
        // User text sent as blocks (VS Code / IDE extension, or any message with
        // an image) was dropped until 2026-09-28: in real sessions whole
        // conversations had no user message at all, so every check that reads
        // what the user said saw nothing. Harness-injected context wrapped in
        // tags (<ide_opened_file>, <system-reminder>, …) is not the user
        // speaking and is stripped; what remains is.
        if (b.type === "text" && typeof b.text === "string") {
          const said = b.text.replace(/<([a-z][\w-]*)>[\s\S]*?<\/\1>/gi, "").trim();
          if (said.length > 0) events.push({ role: "user", kind: "text", text: said, timestamp });
          continue;
        }
        if (b.type === "tool_result") {
          events.push({
            role: "user",
            kind: "tool_result",
            content: extractToolResultText(b.content),
            isError: b.is_error === true,
            timestamp,
            toolUseId: typeof b.tool_use_id === "string" ? b.tool_use_id : undefined,
          });
        }
      }
    }
  }

  return events;
}

/**
 * Parse a whole session file's TEXT (not a path) into events, tracking the
 * permission mode the same way readTranscriptFromFile does — so the browser
 * demo and the CLI agree. Pure: takes the file contents as a string.
 */
export function parseTranscriptText(raw: string): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  let mode: string | undefined;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const m =
        line.match(/"(?:permissionMode|permission_mode)":"([A-Za-z]+)"/) ??
        (line.includes('"permission-mode"') ? line.match(/"mode":"([A-Za-z]+)"/) : null);
      if (m) mode = m[1];
      const parsed = parseLine(line);
      if (mode) for (const e of parsed) if (e.kind === "tool_use") e.permissionMode = mode;
      events.push(...parsed);
    } catch {
      continue;
    }
  }
  return events;
}
