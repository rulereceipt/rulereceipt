import { readFileSync, readdirSync, statSync, realpathSync, existsSync, openSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, basename, sep, isAbsolute } from "node:path";
import { parseTranscriptText, parseLine } from "./transcriptLine.js";
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
 *
 * A hosted/enterprise Claude Code variant can write its sessions under a
 * non-standard home instead of ~/.claude/projects/... — same directory-encoding
 * convention, same file format, different root. Those homes are searched when
 * the user names them (CLAUDE_CONFIG_DIR or RULERECEIPT_CLAUDE_HOMES; see
 * claudeHomes), and the overall latest file across every configured home wins.
 * Discovery is opt-in rather than guessed from whatever dirs exist on the
 * machine (see claudeHomes for why).
 */

/**
 * Claude Code names the per-project directory by mangling the cwd, but the exact
 * rule is not stable or documented across versions: at minimum "/" becomes "-",
 * and observed builds also turn "." "_" and space (every non-alphanumeric) into
 * "-". Guessing the encoding is therefore fragile — a project at
 * /Users/john.doe/my.app, my_project or "My Work" would silently find zero
 * sessions (found by independent test on 0.1.74, 2026-09-29; the whole first
 * screen — check, history, list-sessions, card — showed "No sessions found").
 *
 * So encoding is only a FAST-PATH hint. The source of truth is the `cwd` field
 * every Claude session line carries: this reads the real cwd out of each folder
 * and matches on it (realpath-compared, so symlinks and dotted paths just work),
 * which also survives any future encoding change Claude Code makes.
 */
function encodeCandidates(cwd: string): string[] {
  const slashOnly = cwd.replace(/\//g, "-");
  const allNonAlnum = cwd.replace(/[^A-Za-z0-9]/g, "-");
  return [...new Set([slashOnly, allNonAlnum])];
}

function realpathOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** The cwd a session folder belongs to, read from the first line that carries it. */
export function sessionCwdOf(sessionFile: string): string | null {
  let text: string;
  try {
    text = readFileSync(sessionFile, "utf-8");
  } catch {
    return null;
  }
  // The cwd is on every line; scan only until the first hit (usually line 1).
  let from = 0;
  for (let i = 0; i < 200; i++) {
    const nl = text.indexOf("\n", from);
    const line = text.slice(from, nl === -1 ? undefined : nl);
    if (line.includes('"cwd"')) {
      try {
        const cwd = (JSON.parse(line) as { cwd?: unknown }).cwd;
        if (typeof cwd === "string" && cwd.length > 0) return cwd;
      } catch {
        /* partial/garbled line: keep scanning */
      }
    }
    if (nl === -1) break;
    from = nl + 1;
  }
  return null;
}

/** A cwd looks like a real project root, so descendant (monorepo) sessions are safe to pull in. */
function looksLikeProjectRoot(cwd: string): boolean {
  return [".git", "CLAUDE.md", "AGENTS.md", "GEMINI.md", ".claude", ".cursor", ".github/copilot-instructions.md"].some(
    (marker) => existsSync(join(cwd, marker))
  );
}

/**
 * Absolute paths of every Claude-Code home to search.
 *
 * The standard home `~/.claude`, plus `CLAUDE_CONFIG_DIR` (Claude Code's own
 * override), plus `RULERECEIPT_CLAUDE_HOMES` for anyone running a non-standard
 * layout — both comma-separated, absolute or relative-to-home.
 *
 * It used to glob every `~/.claude*` directory, which swept in whatever extra
 * homes happened to exist on the machine — including a separate or employer home
 * the user never meant the tool to read. That also baked one machine's folder
 * names into the shipped tool. Discovery is now opt-in:
 * nothing beyond `~/.claude` is read unless the user names it. A hosted or
 * enterprise variant on a different home is supported by setting
 * `RULERECEIPT_CLAUDE_HOMES` (or `CLAUDE_CONFIG_DIR`), rather than by guessing.
 */
export function claudeHomes(): string[] {
  const out = new Set<string>();
  out.add(join(homedir(), ".claude"));
  const add = (list: string | undefined): void => {
    if (!list) return;
    for (const part of list.split(",")) {
      const p = part.trim();
      if (p) out.add(isAbsolute(p) ? p : join(homedir(), p));
    }
  };
  add(process.env.CLAUDE_CONFIG_DIR);
  add(process.env.RULERECEIPT_CLAUDE_HOMES);
  return [...out];
}

function listSessionFiles(projectDir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(projectDir);
  } catch {
    return [];
  }

  return entries
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => join(projectDir, name))
    .filter((path) => {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    });
}


/**
 * Every session file that belongs to this project, newest first.
 *
 * A folder matches when the real cwd stored in its sessions is THIS directory
 * (encoding-independent — handles dots, underscores, spaces, symlinks), or when
 * this directory is a project root and the session's cwd is inside it (a
 * monorepo subfolder like packages/api, so the root check sees that work too).
 * Encoding candidates are only a fallback for folders whose stored cwd can't be
 * read.
 */
export function listAllSessionFiles(cwd: string): string[] {
  const target = realpathOr(cwd);
  const candidates = new Set(encodeCandidates(cwd));
  const allowDescendants = looksLikeProjectRoot(cwd);
  const files: string[] = [];
  const seen = new Set<string>();

  for (const home of claudeHomes()) {
    const projectsDir = join(home, "projects");
    let folders: string[];
    try {
      folders = readdirSync(projectsDir);
    } catch {
      continue;
    }
    for (const folder of folders) {
      const dir = join(projectsDir, folder);
      const folderFiles = listSessionFiles(dir);
      if (folderFiles.length === 0) continue;

      const storedCwd = sessionCwdOf(folderFiles[0]);
      let matches = false;
      if (storedCwd) {
        const real = realpathOr(storedCwd);
        if (real === target) matches = true;
        else if (allowDescendants && real.startsWith(target + sep)) matches = true;
      } else {
        // No readable cwd (older/garbled file): fall back to the name encoding.
        matches = candidates.has(folder);
      }
      if (!matches) continue;
      for (const f of folderFiles) {
        if (!seen.has(f)) {
          seen.add(f);
          files.push(f);
        }
      }
    }
  }

  files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return files;
}

export function findLatestSessionFile(cwd: string): string | null {
  const all = listAllSessionFiles(cwd);
  return all.length > 0 ? all[0] : null;
}

// parseLine (and its permission-mode-tracking wrapper parseTranscriptText) live
// in transcriptLine.ts — a pure, Node-free module the browser demo also imports.
export { parseLine } from "./transcriptLine.js";

/**
 * Read the most recently modified session transcript for a project
 * directory. Returns an empty array (not an error) if no session exists
 * yet or the project has never run Claude Code — that's a valid state,
 * not a failure.
 */
export function readTranscriptFromFile(filePath: string): TranscriptEvent[] {
  return readTranscriptWithCoverage(filePath).events;
}

/**
 * How much of a session was actually read, and whether it was cut short.
 *
 * `readFileSync` on a real 262 MB session hangs `check`/`report` (a quarter-gig
 * string, then `.split("\n")` on it). Real incident 2026-10-09: 60–262 MB
 * transcripts on a dev laptop. So the reader STREAMS the file in bounded chunks
 * and stops at a byte OR time budget — bounded memory, bounded time, never a
 * hang. When it stops early, `truncated` is true and the verdict layer must treat
 * the unread tail as "couldn't tell", NEVER as Followed (a PASS over a prefix is
 * not a PASS over the session). See cli.ts, which downgrades on `truncated`.
 */
export interface TranscriptCoverage {
  events: TranscriptEvent[];
  /** True when the byte/time budget stopped the read before EOF. */
  truncated: boolean;
  /** Bytes actually read and parsed. */
  bytesRead: number;
  /** Total size of the file on disk. */
  totalBytes: number;
}

// A generous ceiling: typical sessions are KB–low-MB; this bounds the pathological
// case without cutting a normal session short.
const DEFAULT_MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
// Env override exists ONLY so the budget is testable with a tiny file; production
// uses the 64 MB default. Read lazily so a test can set it per-case.
export function maxTranscriptBytes(): number {
  const n = Number(process.env.RR_MAX_TRANSCRIPT_BYTES);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_TRANSCRIPT_BYTES;
}
/** Back-compat constant for display; the live budget is maxTranscriptBytes(). */
export const MAX_TRANSCRIPT_BYTES = DEFAULT_MAX_TRANSCRIPT_BYTES;
const READ_CHUNK = 1 << 20; // 1 MiB
const DEFAULT_TIME_BUDGET_MS = 10_000;

/**
 * Stream a JSONL transcript line by line with bounded memory, stopping at a byte
 * or wall-clock budget. Replicates parseTranscriptText's permission-mode tracking
 * per line, so a streamed read and a whole-string read agree on a small file.
 */
export function readTranscriptWithCoverage(
  filePath: string,
  opts: { maxBytes?: number; timeBudgetMs?: number } = {}
): TranscriptCoverage {
  const maxBytes = opts.maxBytes ?? maxTranscriptBytes();
  const timeBudgetMs = opts.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
  let totalBytes = 0;
  try { totalBytes = statSync(filePath).size; } catch { /* unreadable -> 0 */ }

  // Small files: the whole-string path keeps the exact, long-tested behaviour.
  if (totalBytes <= maxBytes) {
    let raw = "";
    try { raw = readFileSync(filePath, "utf-8"); } catch { return { events: [], truncated: false, bytesRead: 0, totalBytes }; }
    return { events: parseTranscriptText(raw), truncated: false, bytesRead: Buffer.byteLength(raw), totalBytes };
  }

  // Large file: stream, bounded.
  const events: TranscriptEvent[] = [];
  let mode: string | undefined;
  let bytesRead = 0;
  let truncated = false;
  const started = Date.now();
  const processLine = (line: string): void => {
    if (!line.trim()) return;
    const m =
      line.match(/"(?:permissionMode|permission_mode)":"([A-Za-z]+)"/) ??
      (line.includes('"permission-mode"') ? line.match(/"mode":"([A-Za-z]+)"/) : null);
    if (m) mode = m[1];
    const parsed = parseLine(line);
    if (mode) for (const e of parsed) if (e.kind === "tool_use") e.permissionMode = mode;
    for (const e of parsed) events.push(e);
  };

  let fd: number | undefined;
  try {
    fd = openSync(filePath, "r");
    const buf = Buffer.allocUnsafe(READ_CHUNK);
    let carry = "";
    for (;;) {
      if (bytesRead >= maxBytes) { truncated = true; break; }
      if (Date.now() - started > timeBudgetMs) { truncated = true; break; }
      // Read at most the remaining budget, so the read stops PRECISELY at maxBytes
      // rather than overshooting by up to one chunk (which would read a whole
      // sub-chunk file even past the budget).
      const want = Math.min(READ_CHUNK, maxBytes - bytesRead);
      const n = readSync(fd, buf, 0, want, null);
      if (n === 0) break; // EOF
      bytesRead += n;
      const text = carry + buf.toString("utf-8", 0, n);
      const lines = text.split("\n");
      carry = lines.pop() ?? ""; // last element is a partial line (or "")
      for (const line of lines) processLine(line);
    }
    // A clean EOF (not truncated) leaves a final line with no trailing newline.
    if (!truncated && carry) processLine(carry);
  } catch {
    /* partial read: return what we parsed, marked truncated below if applicable */
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
  }
  if (bytesRead < totalBytes) truncated = true;
  return { events, truncated, bytesRead, totalBytes };
}

/**
 * Read a session file's RAW TEXT, bounded to `maxBytes`. Used for the context
 * scans (breakContext/visibility/shadow signals) that need the raw JSONL, not the
 * parsed events — those previously did `readFileSync` of the whole file, which
 * hung on a 262 MB session just like the parser did. `truncated` lets the caller
 * say the scan only covered the first N bytes.
 */
export function readBoundedText(filePath: string, maxBytes = maxTranscriptBytes()): { text: string; truncated: boolean; totalBytes: number } {
  let totalBytes = 0;
  try { totalBytes = statSync(filePath).size; } catch { return { text: "", truncated: false, totalBytes: 0 }; }
  if (totalBytes <= maxBytes) {
    try { return { text: readFileSync(filePath, "utf-8"), truncated: false, totalBytes }; } catch { return { text: "", truncated: false, totalBytes }; }
  }
  let fd: number | undefined;
  try {
    fd = openSync(filePath, "r");
    const buf = Buffer.allocUnsafe(maxBytes);
    const n = readSync(fd, buf, 0, maxBytes, 0);
    return { text: buf.toString("utf-8", 0, n), truncated: true, totalBytes };
  } catch {
    return { text: "", truncated: true, totalBytes };
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
  }
}

/** Coverage for a session file without re-parsing it (statSync vs the budget). */
export function transcriptCoverage(filePath: string, maxBytes = maxTranscriptBytes()): { truncated: boolean; bytesRead: number; totalBytes: number } {
  let totalBytes = 0;
  try { totalBytes = statSync(filePath).size; } catch { return { truncated: false, bytesRead: 0, totalBytes: 0 }; }
  return totalBytes > maxBytes ? { truncated: true, bytesRead: maxBytes, totalBytes } : { truncated: false, bytesRead: totalBytes, totalBytes };
}

/**
 * Subagent transcripts for a session.
 *
 * Claude Code writes each subagent (a Task/background agent, up to 20 at once
 * and 3 deep as of mid-2026) to its own JSONL under a directory named after
 * the PARENT session id — verified against real files 2026-09-23:
 *   projects/<enc>/<sessionId>/subagents/agent-*.jsonl
 * and each subagent line's own `sessionId` equals that parent id. So for a
 * picked session file `<sessionId>.jsonl`, the subagents sit in a sibling
 * directory named by its basename.
 *
 * These were invisible before: the reader took only the newest top-level
 * file, so a rule broken by a subagent — the exact shape of the risk as
 * Claude Code pushes toward fleets of unattended agents — was never checked.
 *
 * The events are appended to the main stream. Scan checks (git/file/
 * attribution/emoji) simply gain more to inspect; claim-vs-evidence pairs on
 * globally-unique tool ids so it cannot cross-match; the approval gate can at
 * worst treat a main-session "ask" as covering a subagent action, which is a
 * false negative — the safe direction for a tool that must not over-accuse.
 */
export function findSubagentFiles(sessionFile: string): string[] {
  const sessionId = basename(sessionFile).replace(/\.jsonl$/, "");
  const subagentDir = join(dirname(sessionFile), sessionId, "subagents");
  return listSessionFiles(subagentDir);
}

/**
 * A one-line note for the report so a user knows their subagents were included
 * in the check — otherwise the coverage is invisible and they might think a
 * violation a subagent committed went unseen. Null when there were none.
 */
export function subagentNote(sessionFile: string | null): string | null {
  if (!sessionFile) return null;
  const n = findSubagentFiles(sessionFile).length;
  if (n === 0) return null;
  return `Checked ${n} subagent session${n === 1 ? "" : "s"} alongside the main one — their actions are held to the same rules.`;
}

export function readLatestTranscript(cwd: string): TranscriptEvent[] {
  const filePath = findLatestSessionFile(cwd);
  if (!filePath) return [];
  const events = readTranscriptFromFile(filePath);
  for (const sub of findSubagentFiles(filePath)) {
    events.push(...readTranscriptFromFile(sub));
  }
  return events;
}
