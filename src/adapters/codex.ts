import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as zlib from "node:zlib";
import type { TranscriptEvent } from "../types.js";

/**
 * Codex stores rollouts as plain `rollout-*.jsonl` and, once a session is
 * compacted/paginated, Zstandard-compressed `rollout-*.jsonl.zst`. Reading the
 * compressed form needs `node:zlib`'s zstd support, added in Node 22.15 / 23.8.
 * On an older Node it is simply absent — we skip those files with one note
 * rather than crash. (The package's floor is Node 20.)
 */
const zstdDecompressSync: ((buf: Buffer) => Buffer) | undefined =
  (zlib as unknown as { zstdDecompressSync?: (buf: Buffer) => Buffer }).zstdDecompressSync;
let warnedNoZstd = false;

/**
 * Read a rollout file as text, decompressing a `.jsonl.zst` with zstd. Returns
 * null when the file can't be read — unreadable on disk, or compressed on a Node
 * without zstd (noted once). Callers treat null as "no events / no cwd", never a
 * crash.
 */
function readRolloutText(filePath: string): string | null {
  try {
    if (filePath.endsWith(".zst")) {
      if (!zstdDecompressSync) {
        if (!warnedNoZstd) {
          warnedNoZstd = true;
          process.stderr.write(
            "rulereceipt: compressed Codex rollouts (.jsonl.zst) need Node >= 22.15 for zstd; skipping them. Upgrade Node to include them.\n"
          );
        }
        return null;
      }
      return zstdDecompressSync(readFileSync(filePath)).toString("utf-8");
    }
    return readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

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

// Codex function-call names that mean "run a shell command" — normalised to
// the engine's canonical `Bash` tool so the command-scanning checks fire.
// `local_shell_call` is handled by its payload type, not this list.
const SHELL_TOOL_NAMES = new Set([
  "exec_command", "shell", "bash", "sh", "exec", "run_command", "shell_command", "container.exec",
]);

/** Turn an argv array into the command string, unwrapping `sh -c "<script>"`. */
function argvToString(argv: unknown[]): string {
  const parts = argv.map((a) => String(a));
  if (parts.length >= 3 && /^(?:\/(?:usr\/)?bin\/)?(?:ba|z)?sh$/.test(parts[0]) && /^-[a-z]*c$/.test(parts[1])) {
    return parts[2]; // the -c/-lc script is the real command
  }
  return parts.join(" ");
}

/** The shell command string from a tool input, however Codex shaped it. */
function shellCommandString(input: unknown): string | null {
  if (typeof input === "string") return input;
  if (Array.isArray(input)) return argvToString(input);
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    const action = o.action as Record<string, unknown> | undefined;
    const cmd = o.command ?? o.cmd ?? action?.command;
    if (typeof cmd === "string") return cmd;
    if (Array.isArray(cmd)) return argvToString(cmd);
  }
  return null;
}

/** Unescape a JS/JSON string-literal body (the inside of a "...") to real text. */
function unescapeJsString(s: string): string {
  return s.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (m, g: string) => {
    if (g[0] === "u") return String.fromCharCode(parseInt(g.slice(1), 16));
    switch (g) {
      case "n": return "\n";
      case "t": return "\t";
      case "r": return "\r";
      case "b": return "\b";
      case "f": return "\f";
      case '"': return '"';
      case "\\": return "\\";
      case "/": return "/";
      default: return g;
    }
  });
}

/**
 * Codex 0.160+ runs its "exec" custom tool by sending a JAVASCRIPT HARNESS
 * string as the tool input, e.g.
 *   const r = await tools.exec_command({cmd:"git push origin main", ...}); text(r.output);
 *   text(await tools.apply_patch("*** Begin Patch\n*** Update File: a.ts\n..."));
 * The real shell command / file edit is embedded in that string, so the
 * command-scanning checks saw only `const r = await tools.exec_command({cmd:...`
 * and a `git push origin main` produced zero violations (found 2026-10-07 on a
 * real 0.160.1 rollout). Pull the actual command and patch targets back out.
 */
function looksLikeExecHarness(s: string): boolean {
  return /tools\.(exec_command|apply_patch)\s*\(/.test(s) || s.includes("*** Begin Patch");
}

function execHarnessEvents(js: string, timestamp: string, callId: string | undefined): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  const id = typeof callId === "string" ? callId : undefined;

  // apply_patch: one file op per `*** Update/Add/Delete File: <path>` header.
  // The patch lines are separated by an escaped `\n` (the usual, from the JS
  // string literal) OR a real newline (some encodings), so accept both, plus the
  // closing quote as a terminator.
  const fileRe = /\*\*\* (Update|Add|Delete) File: (.+?)(?:\\n|\r?\n|")/g;
  let fm: RegExpExecArray | null;
  while ((fm = fileRe.exec(js)) !== null) {
    const op = fm[1].toLowerCase();
    const path = unescapeJsString(fm[2]).trim();
    if (!path) continue;
    if (op === "delete") {
      events.push({ role: "assistant", kind: "tool_use", toolName: "Bash", input: { command: `rm -- ${path}` }, timestamp, toolUseId: id });
    } else {
      events.push({ role: "assistant", kind: "tool_use", toolName: op === "add" ? "Write" : "Edit", input: { file_path: path }, timestamp, toolUseId: id });
    }
  }

  // exec_command: the real shell command is the cmd:"..." string literal.
  const cm = js.match(/\bcmd\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (cm) {
    events.push({ role: "assistant", kind: "tool_use", toolName: "Bash", input: { command: unescapeJsString(cm[1]) }, timestamp, toolUseId: id });
  }

  return events;
}

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
    const rawName = typeof p.name === "string" ? p.name : "";
    // `arguments` is a JSON string in Codex; parse when possible so the checks
    // see structured input, else keep the raw value.
    let input: unknown = p.arguments ?? p.input ?? p.action ?? {};

    // Codex 0.160+ "exec" custom tool: input is a JS harness string that wraps
    // the real exec_command({cmd}) / apply_patch("*** Begin Patch..."). Pull the
    // command and file edits out BEFORE the JSON parse (the harness is not JSON).
    if (typeof input === "string" && looksLikeExecHarness(input)) {
      const harness = execHarnessEvents(input, timestamp, typeof p.call_id === "string" ? p.call_id : undefined);
      if (harness.length) return harness;
    }

    if (typeof input === "string") {
      try {
        input = JSON.parse(input);
      } catch {
        /* leave as the raw string */
      }
    }

    // NORMALISE shell execution to the engine's canonical shape. Every
    // command-scanning check (git branch, file lifecycle, attribution,
    // approval gate, proposed action, deterministic literals) keys on
    // toolName === "Bash" with input.command as a STRING — Claude's shape.
    // Codex runs shells under `local_shell_call` and `exec_command`-style
    // function calls, so without this none of those checks would fire on a
    // Codex session (found 2026-09-26 when a `git push origin main` in a Codex
    // rollout produced zero violations). Non-shell tools (a real custom/MCP
    // tool) keep their own name and input untouched.
    const isShell = p.type === "local_shell_call" || SHELL_TOOL_NAMES.has(rawName.toLowerCase());
    if (isShell) {
      const command = shellCommandString(input);
      return [
        {
          role: "assistant",
          kind: "tool_use",
          toolName: "Bash",
          input: command !== null ? { command } : input,
          timestamp,
          toolUseId: typeof p.call_id === "string" ? p.call_id : undefined,
        },
      ];
    }

    return [
      {
        role: "assistant",
        kind: "tool_use",
        toolName: rawName || "tool",
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
  const raw = readRolloutText(filePath);
  if (raw === null) return [];
  const events: TranscriptEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    events.push(...parseCodexLine(line));
  }
  return events;
}

/** The cwd a rollout file was recorded in, from its first `session_meta` line. */
export function sessionCwd(filePath: string): string | null {
  const raw = readRolloutText(filePath);
  if (raw === null) return null;
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
    else if (entry.isFile() && entry.name.startsWith("rollout-") && (entry.name.endsWith(".jsonl") || entry.name.endsWith(".jsonl.zst"))) out.push(full);
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
