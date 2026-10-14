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
 * Files a session VIEWED through a single-file Bash reader. Claude Code loads the
 * nested/path-scoped rule governing that file's directory from such a view (the
 * same way Read/Edit do, issue #90450) — but WHICH views trigger it CHANGED across
 * versions, so this is gated on the session's own recorded Claude Code version:
 *
 *   < 2.1.293              a Bash read loads NOTHING (only Read/Write/Edit do).
 *   2.1.293 .. < 2.1.296   a plain single-file reader (cat/head/tail/sed -n/grep/
 *                          bat/less/more) loads, but ONLY with no pipe / chain /
 *                          redirect / substitution. [the first shipped form]
 *   >= 2.1.296             the measured table (yishait-tailor on 2.1.296, via an
 *                          InstructionsLoaded ground-truth hook, #90450, 2026-10-13):
 *                            loads:   cat/head/tail/nl/bat, sed -n, grep/rg — and
 *                                     these ALSO count inside a `;`/`&&` list;
 *                            nothing: pipes, ||, redirects (incl 2>/dev/null),
 *                                     extra flags (cat -A), `cd dir && cat file`,
 *                                     grep -r, and every Bash WRITE.
 *   unknown version        the 2.1.293 behaviour (today's shipped default) — a
 *                          non-regressing fallback. Tagged a modelling choice.
 *
 * Kept SEPARATE from `touchedPaths` on purpose: `touchedPaths` feeds the verdict
 * path's visibility decisions, and widening it would change verdicts — which the
 * approval/visibility hard rule forbids without a fresh FA run. This helper feeds
 * the ADVISORY `edited-rule-not-loaded` shadow signal ONLY, so no change here can
 * move a PASS/FAIL; it still aims to MATCH real behaviour per version.
 *
 * Modelling choices where the transcript can't fully decide (tagged, 2.1.296):
 *  - grep/rg MATCH-dependence ("no match loads nothing") is NOT distinguished from
 *    the tool_use alone; a non-recursive grep/rg with a single trailing path is
 *    counted (the common matched case); `grep -r`/`-R` is excluded by flag. A `;`
 *    inside a quoted sed/grep script can mis-split a segment — that only drops a
 *    view (more advisory firing), never a false suppression.
 *  - "extra flags load nothing": for cat/head/tail/nl/bat only a bare call or a
 *    numeric count flag (head -5 / head -n 5 / tail -n 3) counts; any other flag
 *    (cat -A, -v, …) is treated as non-loading.
 */
const BASH_VIEWERS_LEGACY = new Set(["cat", "head", "tail", "sed", "grep", "bat", "less", "more"]);
const BASH_VIEWERS_REFINED = new Set(["cat", "head", "tail", "nl", "bat", "sed", "grep", "rg"]);

/** The highest `"version":"x.y.z"` recorded in the raw transcript, or undefined. */
export function claudeCodeVersionFromTranscript(text: string | undefined): string | undefined {
  if (!text) return undefined;
  let best: string | undefined;
  const re = /"version"\s*:\s*"(\d+\.\d+\.\d+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) if (!best || cmpVersion(m[1], best) > 0) best = m[1];
  return best;
}

/** Numeric compare of two "a.b.c" version strings; -1 / 0 / 1. */
export function cmpVersion(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export type LoadMode = "none" | "legacy" | "refined";
/** Which Bash-read loading model a session's Claude Code version uses. */
export function loadModeForVersion(version: string | undefined): LoadMode {
  if (!version) return "legacy"; // today's shipped default; non-regressing fallback
  if (cmpVersion(version, "2.1.293") < 0) return "none";
  if (cmpVersion(version, "2.1.296") < 0) return "legacy";
  return "refined";
}

/** The single trailing file a reader segment views, or null. `mode` picks the rule set. */
function readerViewedPath(segment: string, mode: "legacy" | "refined"): string | null {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return null; // need a program and at least one arg
  const prog = tokens[0];
  const viewers = mode === "legacy" ? BASH_VIEWERS_LEGACY : BASH_VIEWERS_REFINED;
  if (!viewers.has(prog)) return null;
  const last = tokens[tokens.length - 1];
  // The last token must be a plain path: not a flag, not a glob, no shell metachar.
  if (!last || last.startsWith("-") || /[*?[\]{}]/.test(last) || /[&|;<>$()`]/.test(last)) return null;

  if (mode === "refined") {
    const flags = tokens.slice(1, -1);
    if (prog === "sed") {
      if (!flags.includes("-n")) return null; // only the reading form `sed -n '…' FILE`
    } else if (prog === "grep" || prog === "rg") {
      if (flags.some((f) => /^--recursive$/.test(f) || /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(f))) return null; // grep -r / -rn / -nr loads nothing
    } else {
      // cat/head/tail/nl/bat: bare, or only a numeric count flag; any other flag loads nothing.
      for (let i = 0; i < flags.length; i++) {
        const f = flags[i];
        if (f === "-n") { i++; continue; } // `-n N`
        if (/^-\d+$/.test(f)) continue; // `-5`
        if (/^-n\d+$/.test(f)) continue; // `-n5`
        return null;
      }
    }
  }
  return last.replace(/^['"]|['"]$/g, "").replace(/\\/g, "/");
}

export function bashViewedPaths(events: TranscriptEvent[], version?: string): string[] {
  const mode = loadModeForVersion(version);
  if (mode === "none") return [];
  const out = new Set<string>();
  for (const e of events) {
    if (e.kind !== "tool_use" || e.toolName !== "Bash") continue;
    const cmd = (e.input as { command?: unknown } | null)?.command;
    if (typeof cmd !== "string") continue;

    if (mode === "legacy") {
      // Reject ANY chaining/pipe/redirect/substitution; the whole command is one reader.
      if (/[|&;><`]|\$\(|<\(/.test(cmd)) continue;
      const p = readerViewedPath(cmd, "legacy");
      if (p) out.add(p);
      continue;
    }

    // refined (>= 2.1.296): pipes / || / redirects / substitution load nothing, but a
    // `;`/`&&` LIST counts — except a command that changes directory (`cd … && cat`).
    if (/[|<>`]|\$\(|<\(|(?<!&)&(?!&)/.test(cmd)) continue; // pipe, ||, redirect, 2>, backtick, $( , <(, lone &
    const segments = cmd.split(/\s*(?:&&|;)\s*/).map((s) => s.trim()).filter(Boolean);
    if (segments.some((s) => /^cd(\s|$)/.test(s))) continue; // `cd dir && cat file` loads nothing
    for (const seg of segments) {
      const p = readerViewedPath(seg, "refined");
      if (p) out.add(p);
    }
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
