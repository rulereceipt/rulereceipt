import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { listAllSessions, parseSessionFile } from "./adapters/index.js";

/**
 * Hook-wiring check (facts only, no verdicts). From anthropics/claude-code#2544:
 * a PreToolUse `matcher` that names a tool Claude Code no longer has fires on
 * nothing, and a write-capable tool a matcher doesn't cover runs unguarded — and
 * nothing tells you. This compares the matchers in your settings against the tool
 * names your recent sessions actually used, and reports the mismatches. It never
 * says a rule was broken; it only points at wiring that can't do what it looks
 * like it does.
 */

export interface HookWiringFinding {
  kind: "dead-matcher" | "unguarded-tool";
  message: string;
}

/** Tools that change the workspace — the ones worth guarding. */
const WRITE_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"];

interface PreToolUseHook { matcher: string | null }

/** Every PreToolUse hook entry across the project + user settings, with its matcher (null = matches all tools). */
function preToolUseHooks(cwd: string, home: string): PreToolUseHook[] {
  const out: PreToolUseHook[] = [];
  for (const p of [join(cwd, ".claude", "settings.json"), join(cwd, ".claude", "settings.local.json"), join(home, ".claude", "settings.json")]) {
    let parsed: { hooks?: { PreToolUse?: unknown } };
    try {
      parsed = JSON.parse(readFileSync(p, "utf-8"));
    } catch {
      continue;
    }
    const pre = parsed?.hooks?.PreToolUse;
    if (!Array.isArray(pre)) continue;
    for (const entry of pre) {
      if (entry && typeof entry === "object") {
        const m = (entry as { matcher?: unknown }).matcher;
        out.push({ matcher: typeof m === "string" && m.trim().length > 0 ? m.trim() : null });
      }
    }
  }
  return out;
}

/** Does any PreToolUse hook match this tool name? A matcher-less hook matches every tool. */
function toolIsGuarded(tool: string, hooks: PreToolUseHook[]): boolean {
  for (const h of hooks) {
    if (h.matcher === null) return true; // no matcher = all tools
    try {
      if (new RegExp(`^(?:${h.matcher})$`).test(tool)) return true;
    } catch {
      if (h.matcher.split("|").map((s) => s.trim()).includes(tool)) return true;
    }
  }
  return false;
}

/** Tool-use counts across the most recent sessions for this cwd (newest first, bounded). */
function recentToolUsage(cwd: string, maxSessions = 10): { counts: Map<string, number>; sessions: number } {
  const counts = new Map<string, number>();
  const all = listAllSessions(cwd)
    .map((s) => ({ ...s, mtime: safeMtime(s.file) }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, maxSessions);
  let scanned = 0;
  for (const { file } of all) {
    let events;
    try {
      events = parseSessionFile(file);
    } catch {
      continue;
    }
    if (events.length === 0) continue;
    scanned++;
    for (const e of events) {
      if (e.kind === "tool_use" && e.toolName) counts.set(e.toolName, (counts.get(e.toolName) ?? 0) + 1);
    }
  }
  return { counts, sessions: scanned };
}

function safeMtime(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Which tool names a matcher explicitly names, so a dead one can be called out.
 * Only the simple alternation form (`Write|Edit|MultiEdit`) is introspected; a
 * wildcard/regex matcher (`.*`, `Notebook.*`) names no literal tool, so it is
 * never reported dead.
 */
function namedTools(matcher: string): string[] {
  if (/[.*+?()[\]\\^$]/.test(matcher)) return []; // a real regex, not a plain name list
  return matcher.split("|").map((s) => s.trim()).filter((s) => /^[A-Za-z][A-Za-z0-9_]*$/.test(s));
}

export function hookWiringFindings(cwd: string, home: string = homedir()): HookWiringFinding[] {
  const hooks = preToolUseHooks(cwd, home);
  if (hooks.length === 0) return []; // no PreToolUse hooks wired: nothing to check
  const { counts, sessions } = recentToolUsage(cwd);
  if (sessions === 0) return []; // no recent sessions to compare against: stay silent
  const findings: HookWiringFinding[] = [];

  // Dead matcher: a matcher names a tool that NONE of the recent sessions used.
  for (const h of hooks) {
    if (h.matcher === null) continue;
    for (const tool of namedTools(h.matcher)) {
      if (!counts.has(tool)) {
        findings.push({
          kind: "dead-matcher",
          message: `PreToolUse matcher names "${tool}", but no tool by that name was used in your last ${sessions} session${sessions === 1 ? "" : "s"} — check the spelling (Claude Code has no "${tool}" tool, or you don't use it), or the hook is guarding nothing.`,
        });
      }
    }
  }

  // Unguarded tool: a write-capable tool WAS used, but no PreToolUse matcher covers it.
  for (const tool of WRITE_TOOLS) {
    const n = counts.get(tool) ?? 0;
    if (n > 0 && !toolIsGuarded(tool, hooks)) {
      findings.push({
        kind: "unguarded-tool",
        message: `${tool} ran ${n} time${n === 1 ? "" : "s"} in your last ${sessions} session${sessions === 1 ? "" : "s"}, but no PreToolUse hook matches it — nothing checks ${tool} before it runs. Add it to a matcher (or use a matcher-less hook).`,
      });
    }
  }
  return findings;
}
