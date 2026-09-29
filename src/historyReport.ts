import { statSync } from "node:fs";
import { listAllSessions } from "./adapters/index.js";
import { evaluateSession } from "./evaluate.js";
import type { CheckResult, Rule } from "./types.js";

/**
 * History mode — the first-run "wait, what?" screen.
 *
 * `npx rulereceipt` with no arguments checks EVERY session for this project in
 * the last 30 days, not just the latest one, and leads with the proven breaks:
 * "Claude broke your rules 11 times", each line a rule, a count, the last date
 * and one quoted evidence line. The headline counts ONLY proven Broken verdicts
 * (a structured FAIL with evidence) — judgment calls stay in their own line so
 * the number can never overstate. Everything is from the user's own history,
 * with the quote, which is what makes it believable enough to screenshot.
 *
 * Deliberately no network and no API key: judgment rules report UNCLEAR (never
 * an LLM call) exactly as a plain `check` does.
 */

export interface HistoryBreak {
  ruleId: string;
  ruleTitle: string;
  ruleSource: "global" | "project";
  /** How many sessions in the window broke it. */
  count: number;
  /** The most recent session (ms epoch) that broke it. */
  lastMs: number;
  /** One evidence line, from the first break seen. */
  quote: string;
}

export interface HistorySummary {
  sessionsScanned: number;
  days: number;
  /** Tool ids that contributed sessions, e.g. ["claude-code"]. */
  tools: string[];
  /** Proven breaks, grouped by rule, most-broken first. */
  breaks: HistoryBreak[];
  /** Sum of break counts — the headline number. */
  totalBrokenCount: number;
  /** Rules followed at least once and never broken, in the window. */
  followedRules: number;
  /** Rules that need a human's judgment (never mechanically decided). */
  judgmentRules: number;
  elapsedMs: number;
}

function needsLlmResult(rule: Rule): CheckResult {
  return { ruleId: rule.id, ruleTitle: rule.title, ruleSource: rule.source, status: "UNCLEAR", needsHuman: true, evidence: "" };
}

const key = (r: { ruleSource: string; ruleId: string; ruleTitle: string }) => `${r.ruleSource}\u0000${r.ruleId}\u0000${r.ruleTitle}`;

/**
 * Scan every session for `cwd` in the last `days` days and aggregate the
 * proven breaks. Sessions are read newest-first and each is run through the
 * SAME engine as `check`, so a break here is a break there.
 */
export async function scanHistory(
  cwd: string,
  rules: Rule[],
  days = 30,
  now = Date.now(),
  sessions: { adapter: { tool: string; parse(f: string): import("./types.js").TranscriptEvent[] }; file: string }[] = listAllSessions(cwd)
): Promise<HistorySummary> {
  const started = Date.now();
  const cutoff = now - days * 24 * 60 * 60 * 1000;

  interface Agg {
    title: string;
    source: "global" | "project";
    id: string;
    breaks: { ms: number; quote: string }[];
    passed: boolean;
    judgment: boolean;
  }
  const rules_ = new Map<string, Agg>();
  const tools = new Set<string>();
  let sessionsScanned = 0;

  /** The latest event timestamp in a session, or null if none parse. */
  const lastEventMs = (events: { timestamp: string }[]): number | null => {
    let max = 0;
    for (const e of events) {
      const t = Date.parse(e.timestamp);
      if (!Number.isNaN(t) && t > max) max = t;
    }
    return max > 0 ? max : null;
  };

  for (const { adapter, file } of sessions) {
    let ms: number;
    try {
      ms = statSync(file).mtimeMs;
    } catch {
      continue;
    }
    if (ms < cutoff) continue;
    let events;
    try {
      events = adapter.parse(file);
    } catch {
      continue; // one unreadable session must not sink the whole scan
    }
    if (events.length === 0) continue;
    sessionsScanned++;
    tools.add(adapter.tool);
    // The DATE shown is the session's own last timestamp, not the file's mtime —
    // a file touched today can hold a session from last week, and showing "last:
    // today" for it is wrong (found by a real test, 2026-09-29). Falls back to
    // the mtime only when the transcript carries no usable timestamp.
    const sessionMs = lastEventMs(events) ?? ms;
    const { results } = await evaluateSession(cwd, rules, events, false, needsLlmResult);
    for (const r of results) {
      const k = key(r);
      let a = rules_.get(k);
      if (!a) {
        a = { title: r.ruleTitle, source: r.ruleSource, id: r.ruleId, breaks: [], passed: false, judgment: false };
        rules_.set(k, a);
      }
      if (r.status === "FAIL") a.breaks.push({ ms: sessionMs, quote: r.evidence });
      else if (r.status === "PASS") a.passed = true;
      else if (r.status === "UNCLEAR" && r.needsHuman) a.judgment = true;
    }
  }

  const breaks: HistoryBreak[] = [];
  let followedRules = 0;
  let judgmentRules = 0;
  for (const a of rules_.values()) {
    if (a.breaks.length > 0) {
      const last = a.breaks.reduce((m, b) => (b.ms > m.ms ? b : m), a.breaks[0]);
      breaks.push({ ruleId: a.id, ruleTitle: a.title, ruleSource: a.source, count: a.breaks.length, lastMs: last.ms, quote: a.breaks[0].quote });
    } else if (a.passed) {
      followedRules++;
    } else if (a.judgment) {
      judgmentRules++;
    }
  }
  breaks.sort((x, y) => y.count - x.count || y.lastMs - x.lastMs);

  return {
    sessionsScanned,
    days,
    tools: [...tools],
    breaks,
    totalBrokenCount: breaks.reduce((n, b) => n + b.count, 0),
    followedRules,
    judgmentRules,
    elapsedMs: Date.now() - started,
  };
}

function relDate(ms: number, now = Date.now()): string {
  const day = 24 * 60 * 60 * 1000;
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  if (ms >= startOfToday) return "today";
  if (ms >= startOfToday - day) return "yesterday";
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

const toolLabel = (t: string) => (t === "claude-code" ? "Claude Code" : t === "codex" ? "Codex" : t);

/** The headline screen. Proven breaks first, then the followed / judgment line. */
export function renderHistory(s: HistorySummary, projectName: string, now = Date.now()): string {
  const out: string[] = [];
  const secs = (s.elapsedMs / 1000).toFixed(1);
  const toolNote = s.tools.length ? `${s.tools.map(toolLabel).join(" + ")} ` : "";
  out.push(`RuleReceipt · ${projectName} · last ${s.days} days · ${s.sessionsScanned} ${toolNote}session${s.sessionsScanned === 1 ? "" : "s"}`);
  out.push("");

  if (s.sessionsScanned === 0) {
    out.push("No coding-agent sessions found for this project in the window.");
    out.push("Run Claude Code (or Codex) here, then try `rulereceipt` again — or `rulereceipt demo` to see a sample.");
    return out.join("\n");
  }

  if (s.breaks.length === 0) {
    out.push("No proven breaks found in these sessions (a structured check with quoted evidence). Rules needing judgment are shown per-session, not counted here.");
  } else {
    const who = s.tools.length === 1 && s.tools[0] === "claude-code" ? "Claude" : "the agent";
    out.push(`${who} broke your rules ${s.totalBrokenCount} time${s.totalBrokenCount === 1 ? "" : "s"}.`);
    out.push("");
    for (const b of s.breaks.slice(0, 10)) {
      const title = b.ruleTitle.replace(/\s+/g, " ").trim().slice(0, 60);
      const when = relDate(b.lastMs, now);
      out.push(`  x  ${title}    ${b.count} time${b.count === 1 ? "" : "s"}   last: ${when}`);
      if (b.quote) out.push(`       ${b.quote.replace(/\s+/g, " ").trim().slice(0, 100)}`);
    }
  }
  out.push("");
  out.push(`  ${s.followedRules} rule${s.followedRules === 1 ? "" : "s"} followed every time · ${s.judgmentRules} need${s.judgmentRules === 1 ? "s" : ""} your judgment`);
  out.push("");
  out.push(`checked ${s.sessionsScanned} session${s.sessionsScanned === 1 ? "" : "s"} in ${secs}s`);
  out.push("");
  out.push("See one session in full:  rulereceipt check");
  out.push("Think a verdict is wrong?  rulereceipt wrong <rule>");
  return out.join("\n");
}
