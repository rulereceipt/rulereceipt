import type { TranscriptEvent } from "../types.js";

/**
 * Path-scoped rules: when does Claude actually see them?
 *
 * Claude Code loads a `.claude/rules/*.md` file carrying `paths:` frontmatter
 * only when the session works on a file matching one of its patterns. Cursor
 * `.mdc` rules with `globs:` (and agy `.agents/rules` with `trigger: glob`)
 * behave the same way. A session that never touched a matching file never
 * had the rule in context, so no verdict about it can be fair.
 *
 * Direction of error, deliberately: patterns are matched against every
 * trailing segment of the absolute path, because the transcript records
 * absolute paths and the project root is not always known. That can
 * over-match (treat a rule as loaded when it was not), which falls back to
 * today's behaviour. It cannot under-match a real file, which is the side
 * that would hide a real violation.
 */

const FILE_TOOLS: Record<string, string> = {
  Read: "file_path",
  Edit: "file_path",
  MultiEdit: "file_path",
  Write: "file_path",
  NotebookEdit: "notebook_path",
};

export function touchedPaths(events: TranscriptEvent[]): string[] {
  const out = new Set<string>();
  for (const e of events) {
    if (e.kind !== "tool_use") continue;
    const field = FILE_TOOLS[e.toolName];
    if (!field) continue;
    const v = (e.input as Record<string, unknown> | null)?.[field];
    if (typeof v === "string" && v.length > 0) out.add(v.replace(/\\/g, "/"));
  }
  return [...out];
}

/**
 * Files a session VIEWED through a single-file Bash reader — `cat FILE`,
 * `head FILE`, `tail FILE`, `sed -n … FILE`, `grep … FILE`. Since Claude Code
 * 2.1.293 such a view ALSO loads a nested/path-scoped rule governing that file's
 * directory, the same way Read/Edit do (issue #90450, 2026-10-09). This is kept
 * SEPARATE from `touchedPaths` on purpose: `touchedPaths` feeds the verdict
 * path's visibility decisions, and widening it would change verdicts — which the
 * approval/visibility hard rule forbids without a fresh FA run. This helper is
 * for the ADVISORY "edited without the rule loaded" shadow signal only.
 *
 * Deliberately narrow and fails safe: only a reader whose FINAL argument is a
 * single path, with NO pipe / redirection / chaining / command-substitution /
 * glob / option-valued flag confusion — because a piped or chained command does
 * NOT trigger the nested load (per the same issue), so counting it would be
 * wrong. When in doubt the file is simply not returned.
 */
const BASH_VIEWERS = new Set(["cat", "head", "tail", "sed", "grep", "bat", "less", "more"]);
export function bashViewedPaths(events: TranscriptEvent[]): string[] {
  const out = new Set<string>();
  for (const e of events) {
    if (e.kind !== "tool_use" || e.toolName !== "Bash") continue;
    const cmd = (e.input as { command?: unknown } | null)?.command;
    if (typeof cmd !== "string") continue;
    // Reject anything chained/piped/redirected/substituted — those don't trigger
    // the nested load, so they must not count.
    if (/[|&;><`]|\$\(|<\(/.test(cmd)) continue;
    const tokens = cmd.trim().split(/\s+/);
    if (tokens.length === 0) continue;
    const prog = tokens[0];
    if (!BASH_VIEWERS.has(prog)) continue;
    // The last token must be a plain path (not a flag, not a glob).
    const last = tokens[tokens.length - 1];
    if (!last || last.startsWith("-") || /[*?[\]{}]/.test(last)) continue;
    // `sed -n '…' FILE` carries a script arg; still a single trailing file.
    out.add(last.replace(/^['"]|['"]$/g, "").replace(/\\/g, "/"));
  }
  return [...out];
}

function expandBraces(glob: string): string[] {
  const m = glob.match(/\{([^{}]*)\}/);
  if (!m || m.index === undefined) return [glob];
  const head = glob.slice(0, m.index);
  const tail = glob.slice(m.index + m[0].length);
  return m[1].split(",").flatMap((alt) => expandBraces(head + alt + tail));
}

export function globToRegExp(glob: string): RegExp {
  let g = glob.trim().replace(/^\.\//, "");
  if (g.startsWith("/")) g = g.slice(1);
  if (g.endsWith("/")) g += "**";
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        const slashAfter = g[i + 2] === "/";
        re += slashAfter ? "(?:.*/)?" : ".*";
        i += slashAfter ? 2 : 1;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

function suffixes(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  const out: string[] = [];
  for (let i = parts.length - 1; i >= 0; i--) out.push(parts.slice(i).join("/"));
  return out;
}

/** True when any touched file matches any of the rule's patterns. */
export function ruleWasLoaded(patterns: string[], touched: string[]): boolean {
  const regexes = patterns.flatMap(expandBraces).filter((p) => p.trim().length > 0).map(globToRegExp);
  if (regexes.length === 0) return true; // an empty scope is no scope: treat as always loaded
  for (const path of touched) {
    for (const s of suffixes(path)) {
      if (regexes.some((r) => r.test(s))) return true;
    }
  }
  return false;
}
