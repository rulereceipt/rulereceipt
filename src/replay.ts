import { statSync } from "node:fs";
import { listAllSessions, parseSessionFile } from "./adapters/index.js";
import { guardDecision } from "./guard.js";
import type { TranscriptEvent } from "./types.js";

/**
 * Shadow replay: run the CURRENT guard + rules against PAST sessions, and report
 * what it WOULD have done — nothing is blocked, nothing is changed. It answers
 * "if I turn protect on, what catches?" before you turn it on, and "did my rules
 * ever actually matter here?" after. Same honesty bar as everything else: it
 * counts calls, not vibes, and shows the rule and command behind each number.
 */

const GUARDED_TOOLS = new Set(["Bash", "Write", "Edit", "NotebookEdit"]);

export interface ReplayResult {
  sessions: number;
  calls: number;
  wouldDeny: number;
  wouldAsk: number;
  byRule: { ruleTitle: string; deny: number; ask: number }[];
  examples: { verdict: "deny" | "ask"; ruleTitle: string; detail: string }[];
}

export function replayGuard(cwd: string, opts: { maxSessions?: number } = {}): ReplayResult {
  const maxSessions = opts.maxSessions ?? 20;
  const files = listAllSessions(cwd)
    .map((s) => ({ file: s.file, mtime: safeMtime(s.file) }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, maxSessions);

  const byRule = new Map<string, { deny: number; ask: number }>();
  const examples: ReplayResult["examples"] = [];
  let sessions = 0;
  let calls = 0;
  let wouldDeny = 0;
  let wouldAsk = 0;

  for (const { file } of files) {
    let events: TranscriptEvent[];
    try {
      events = parseSessionFile(file);
    } catch {
      continue;
    }
    if (events.length === 0) continue;
    sessions++;
    // Walk forward, passing only the events BEFORE each call as context — so an
    // approval that happened earlier in the real session still counts, exactly
    // as the live guard would have seen it.
    const prefix: TranscriptEvent[] = [];
    for (const e of events) {
      if (e.kind === "tool_use" && e.toolName && GUARDED_TOOLS.has(e.toolName) && e.input) {
        calls++;
        const d = guardDecision(cwd, e.toolName, e.input as Record<string, unknown>, prefix, e.permissionMode);
        if (d.deny) {
          wouldDeny++;
          for (const b of d.blocks) bump(byRule, b.rule.title, "deny");
          if (examples.length < 10 && d.blocks[0]) examples.push({ verdict: "deny", ruleTitle: d.blocks[0].rule.title, detail: oneLine(d.reason) });
        } else if (d.ask) {
          wouldAsk++;
          // ask has no block list; attribute to the rule named in the ask text if present
          const title = ruleTitleFromAsk(d.ask);
          bump(byRule, title, "ask");
          if (examples.length < 10) examples.push({ verdict: "ask", ruleTitle: title, detail: oneLine(d.ask) });
        }
      }
      prefix.push(e);
    }
  }

  const rows = [...byRule.entries()]
    .map(([ruleTitle, v]) => ({ ruleTitle, ...v }))
    .sort((a, b) => b.deny + b.ask - (a.deny + a.ask));

  return { sessions, calls, wouldDeny, wouldAsk, byRule: rows, examples };
}

function bump(m: Map<string, { deny: number; ask: number }>, title: string, kind: "deny" | "ask") {
  const cur = m.get(title) ?? { deny: 0, ask: 0 };
  cur[kind]++;
  m.set(title, cur);
}

function ruleTitleFromAsk(ask: string): string {
  const m = ask.match(/rule[: ]+"?([^"\n]+?)"?[.\n]/i);
  return m ? m[1].trim() : "approval-gated action";
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, 140);
}

function safeMtime(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

export function renderReplay(r: ReplayResult): string {
  const out: string[] = [];
  out.push("SHADOW REPLAY — nothing was blocked. This is what your current rules WOULD");
  out.push("have done against your recent sessions, had the guard been active then.\n");
  if (r.sessions === 0) {
    out.push("No recent sessions found for this project. Nothing to replay.");
    return out.join("\n");
  }
  out.push(`Scanned ${r.calls} guarded call${r.calls === 1 ? "" : "s"} across ${r.sessions} session${r.sessions === 1 ? "" : "s"}.`);
  out.push(`Would have DENIED: ${r.wouldDeny}`);
  out.push(`Would have ASKED (prompted you): ${r.wouldAsk}`);
  if (r.wouldDeny === 0 && r.wouldAsk === 0) {
    out.push("\nNo call in these sessions would have been blocked or prompted. Either your");
    out.push("agent already followed these rules, or the rules don't cover what it did.");
    return out.join("\n");
  }
  if (r.byRule.length > 0) {
    out.push("\nBy rule:");
    for (const row of r.byRule) {
      const parts = [row.deny ? `${row.deny} deny` : "", row.ask ? `${row.ask} ask` : ""].filter(Boolean).join(", ");
      out.push(`  • ${row.ruleTitle.replace(/\s+/g, " ").trim().slice(0, 64)} — ${parts}`);
    }
  }
  if (r.examples.length > 0) {
    out.push("\nExamples:");
    for (const ex of r.examples) out.push(`  [${ex.verdict}] ${ex.detail}`);
  }
  return out.join("\n");
}
