import { statSync } from "node:fs";
import { listAllSessions } from "./adapters/index.js";
import { withoutHeredocs } from "./checks/shellCommand.js";
import type { TranscriptEvent } from "./types.js";

/**
 * "What did your agent actually do?" — for someone with sessions but NO rules
 * file. History mode needs rules to judge; this needs none. It just reports a
 * few plainly-observable actions across recent sessions (pushes, edits to
 * `.env`, "the tests pass" claims), so a first-time user sees something true
 * about their own work even before they've written a single rule, and then
 * `init --from-history` drafts a starter rules file from what it saw.
 *
 * These are OBSERVATIONS, not verdicts — nothing here says a rule was broken,
 * because there is no rule yet. The wording stays factual ("pushed 9 times")
 * and the checkers' polarity/false-accusation discipline does not apply,
 * precisely because nothing is being accused.
 */

const PUSH = /\bgit\s+(?:\S+\s+){0,4}?push(?![\w-])/;
const COMMIT = /\bgit\s+(?:\S+\s+){0,4}?commit(?![\w-])/;
const ENV_FILE = /(?:^|[\\/])\.env(?:\.[\w.-]+)?$/;
// A "the tests pass" style completion claim — the strongest, least-noisy signal.
const TESTS_PASS_CLAIM = /\b(?:all\s+)?tests?\s+(?:are\s+)?(?:pass(?:ing|ed|es)?|green)\b|\ball\s+green\b|\beverything\s+(?:passes|works)\b/i;
const TEST_COMMAND = /\b(?:npm\s+(?:run\s+)?test|npx\s+vitest|vitest|jest|pytest|go\s+test|cargo\s+test|mvn\s+test|rspec|phpunit|\btox\b)\b/;

function bashCommand(e: TranscriptEvent): string {
  if (e.kind !== "tool_use" || e.toolName !== "Bash") return "";
  const c = (e.input as { command?: unknown } | null)?.command;
  return typeof c === "string" ? withoutHeredocs(c) : "";
}

function editedPath(e: TranscriptEvent): string {
  if (e.kind !== "tool_use") return "";
  if (e.toolName !== "Write" && e.toolName !== "Edit" && e.toolName !== "MultiEdit" && e.toolName !== "NotebookEdit") return "";
  const p = (e.input as { file_path?: unknown; notebook_path?: unknown } | null);
  const path = p?.file_path ?? p?.notebook_path;
  return typeof path === "string" ? path : "";
}

export interface SessionObservations {
  sessions: number;
  days: number;
  tools: string[];
  pushes: number;
  commits: number;
  envWrites: number;
  /** "the tests pass" claims where no test command ran anywhere in that session. */
  testClaimsNoRun: number;
  testClaims: number;
  elapsedMs: number;
}

export function observeSessions(
  cwd: string,
  days = 30,
  now = Date.now(),
  sessions = listAllSessions(cwd)
): SessionObservations {
  const started = Date.now();
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  const tools = new Set<string>();
  let scanned = 0, pushes = 0, commits = 0, envWrites = 0, testClaims = 0, testClaimsNoRun = 0;

  for (const { adapter, file } of sessions) {
    let ms: number;
    try {
      ms = statSync(file).mtimeMs;
    } catch {
      continue;
    }
    if (ms < cutoff) continue;
    let events: TranscriptEvent[];
    try {
      events = adapter.parse(file);
    } catch {
      continue;
    }
    if (events.length === 0) continue;
    scanned++;
    tools.add(adapter.tool);
    const ranTest = events.some((e) => TEST_COMMAND.test(bashCommand(e)));
    for (const e of events) {
      const cmd = bashCommand(e);
      if (cmd && PUSH.test(cmd)) pushes++;
      if (cmd && COMMIT.test(cmd)) commits++;
      if (ENV_FILE.test(editedPath(e))) envWrites++;
      if (e.kind === "text" && e.role === "assistant" && TESTS_PASS_CLAIM.test(e.text)) {
        testClaims++;
        if (!ranTest) testClaimsNoRun++;
      }
    }
  }

  return { sessions: scanned, days, tools: [...tools], pushes, commits, envWrites, testClaims, testClaimsNoRun, elapsedMs: Date.now() - started };
}

const toolLabel = (t: string) => (t === "claude-code" ? "Claude Code" : t === "codex" ? "Codex" : t);

/** The no-rules screen: what the agent did, and how to turn it into rules. */
export function renderNoRules(o: SessionObservations, projectName: string): string {
  const who = o.tools.length === 1 && o.tools[0] === "claude-code" ? "Claude" : "your agent";
  const out: string[] = [];
  const toolNote = o.tools.length ? `${o.tools.map(toolLabel).join(" + ")} ` : "";
  out.push(`RuleReceipt · ${projectName} · last ${o.days} days · ${o.sessions} ${toolNote}session${o.sessions === 1 ? "" : "s"}`);
  out.push("");
  out.push(`You don't have a rules file yet, so there's nothing to check against. Here's what ${who} actually did:`);
  out.push("");
  out.push(`  pushed ${o.pushes} time${o.pushes === 1 ? "" : "s"}`);
  out.push(`  committed ${o.commits} time${o.commits === 1 ? "" : "s"}`);
  out.push(`  wrote to a .env file ${o.envWrites} time${o.envWrites === 1 ? "" : "s"}`);
  out.push(`  claimed the tests pass ${o.testClaims} time${o.testClaims === 1 ? "" : "s"}${o.testClaimsNoRun > 0 ? ` (${o.testClaimsNoRun} with no test command run that session)` : ""}`);
  out.push("");
  out.push("Turn this into rules to check from now on:");
  out.push("  rulereceipt init --from-history   (drafts a starter CLAUDE.md from the above — never overwrites)");
  out.push("");
  out.push(`checked ${o.sessions} session${o.sessions === 1 ? "" : "s"} in ${(o.elapsedMs / 1000).toFixed(1)}s · nothing uploaded`);
  return out.join("\n");
}

/** A starter rules file drafted from the observed actions. Only rules for things that happened. */
export function draftRulesFromHistory(o: SessionObservations): string {
  const lines: string[] = [
    "# Project rules (draft)",
    "",
    "# Drafted by `rulereceipt init --from-history` from what your agent did in the",
    "# last " + o.days + " days. Keep the ones you want, delete the rest, then move this",
    "# to CLAUDE.md (or AGENTS.md) in your project root.",
    "",
  ];
  let n = 0;
  if (o.pushes > 0) lines.push(`## ${++n}. Never push without asking`, "Don't run `git push` unless I've asked for it in this session.", "");
  if (o.commits > 0) lines.push(`## ${++n}. Ask before committing`, "Don't `git commit` unless I've asked for it.", "");
  if (o.envWrites > 0) lines.push(`## ${++n}. Never edit \`.env\``, "Don't write to `.env` or any `.env.*` file.", "");
  if (o.testClaims > 0) lines.push(`## ${++n}. Don't say the tests pass without running them`, "Only say the tests pass after actually running the test command in this session.", "");
  if (n === 0) {
    lines.push("# Nothing risky was observed to base a rule on. Write your own, e.g.:");
    lines.push("## 1. Never push to `main`");
    lines.push("Never push directly to the `main` branch.");
    lines.push("");
  }
  return lines.join("\n") + "\n";
}
