import { readFileSync, readdirSync, statSync, realpathSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, basename, sep } from "node:path";
import { parseTranscriptText } from "./transcriptLine.js";
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
 * Real gap found 2026-08-30: a hosted/enterprise Claude Code variant on
 * one real machine writes to ~/.claude-office/projects/... instead of
 * ~/.claude/projects/... — same directory-encoding convention, same file
 * format, different root. `rulereceipt check` reported "no session found"
 * on 4 real projects that had extensive real work done, purely because it
 * only ever looked in one root.
 *
 * Hardcoding ".claude-office" specifically would only fix THIS machine's
 * naming — a different org's hosted variant could use any name. Instead,
 * every directory directly under the home dir that starts with ".claude"
 * and has a matching projects/<encoded-cwd> tree is treated as a
 * candidate, and the overall latest file across all of them wins. This
 * generalizes to variants never seen on this machine, at the cost of one
 * extra readdir() of the home directory per check — negligible.
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
function sessionCwdOf(sessionFile: string): string | null {
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

/** Absolute paths of every Claude-Code-style home to search, including CLAUDE_CONFIG_DIR. */
function claudeHomeDirs(): string[] {
  const dirs = new Set<string>();
  for (const name of findClaudeHomeDirNames()) dirs.add(join(homedir(), name));
  const cfg = process.env.CLAUDE_CONFIG_DIR;
  if (cfg) for (const part of cfg.split(",")) {
    const p = part.trim();
    if (p) dirs.add(p);
  }
  return [...dirs];
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
 * Also used for the global CLAUDE.md lookup (src/cli.ts) — the same
 * ".claude vs .claude-office" gap applies there too: a hosted/enterprise
 * variant could keep its own global rules file under its own home dir.
 */
export function findClaudeHomeDirNames(): string[] {
  try {
    return readdirSync(homedir(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(".claude"))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
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

  for (const home of claudeHomeDirs()) {
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
  // Pure parsing (including permission-mode tracking) lives in transcriptLine.ts
  // so the browser demo can run the exact same logic on a dropped file.
  return parseTranscriptText(readFileSync(filePath, "utf-8"));
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
