import { execFileSync } from "node:child_process";
import { parseClaudeMdText } from "./parsers/claudeMdParser.js";
import { ruleFingerprint } from "./overrides.js";
import type { Rule, TranscriptEvent } from "./types.js";

/**
 * A rule cannot have been broken by a session that ran before the rule
 * existed.
 *
 * Raised by etoryoki on anthropics/claude-code#2544 (2026-09-24), from real
 * use: a first pass over 14 days of sessions flagged 37 violations, and all
 * 37 came from sessions that ran BEFORE those rules were added to the file —
 * an old session held to a file written later the same day. Dating each rule
 * from git removed all of them.
 *
 * This checks by rule SET, not by line: the CLAUDE.md is reconstructed as it
 * stood at the session's start time, parsed, and its rules fingerprinted. A
 * current project rule whose fingerprint is absent from that historical set
 * did not exist during the session, so it is marked not-applicable rather
 * than checked. Uses the same content-hash handle the rest of the tool keys
 * on, so no line tracking is needed.
 *
 * Fails OPEN, everywhere: not a git repo, git absent, file untracked, a
 * session with no timestamps — any of these return null and NOTHING is
 * filtered, so a rule is never wrongly hidden. It only ever removes a
 * false accusation, never creates a miss.
 *
 * Scope, stated: only the project CLAUDE.md at the working directory. Global
 * (~/.claude) rules live in a different repo and AGENTS.md/subdir files are
 * out of scope for this first cut; those are simply never filtered.
 */

/** The earliest timestamp in the transcript — when the session began. */
export function sessionStartTime(events: TranscriptEvent[]): string | null {
  let earliest: string | null = null;
  for (const e of events) {
    const t = e.timestamp;
    if (!t) continue;
    if (earliest === null || t < earliest) earliest = t;
  }
  return earliest;
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

/**
 * The fingerprints of the project CLAUDE.md's rules as they stood at
 * `isoTime`, or null when that cannot be determined (fail open).
 */
export function projectHandlesAtTime(cwd: string, isoTime: string): Set<string> | null {
  const prefix = git(cwd, ["rev-parse", "--show-prefix"]);
  if (prefix === null) return null; // not a git repo
  const relPath = `${prefix.trim()}CLAUDE.md`;

  const commit = git(cwd, ["log", "-1", `--before=${isoTime}`, "--format=%H", "--", relPath]);
  if (commit === null) return null;
  const sha = commit.trim();
  if (!sha) return null; // no commit to this file before the session began

  const content = git(cwd, ["show", `${sha}:${relPath}`]);
  if (content === null) return null; // untracked at that commit

  const handles = new Set<string>();
  for (const rule of parseClaudeMdText(content, "project")) handles.add(ruleFingerprint(rule));
  return handles;
}

/** A rule that did not exist when the session ran. */
export function futureResult(rule: Rule): {
  ruleId: string; ruleTitle: string; ruleSource: "global" | "project";
  status: "UNCLEAR"; outcome: "not_applicable"; method: "none"; evidence: string;
} {
  return {
    ruleId: rule.id, ruleTitle: rule.title, ruleSource: rule.source,
    status: "UNCLEAR", outcome: "not_applicable", method: "none",
    evidence: "this rule was added to CLAUDE.md after the session ran, so the session could not have followed or broken it",
  };
}

/**
 * Splits rules into those that existed when the session ran and those added
 * afterwards. When history is unavailable, everything is "present" — nothing
 * is filtered.
 */
export function partitionByAge(
  cwd: string,
  rules: Rule[],
  events: TranscriptEvent[]
): { present: Rule[]; future: Rule[] } {
  const startedAt = sessionStartTime(events);
  if (!startedAt) return { present: rules, future: [] };
  const historical = projectHandlesAtTime(cwd, startedAt);
  if (historical === null) return { present: rules, future: [] };

  const present: Rule[] = [];
  const future: Rule[] = [];
  for (const rule of rules) {
    // Only project rules are datable here; global rules are never filtered.
    if (rule.source === "project" && !historical.has(ruleFingerprint(rule))) future.push(rule);
    else present.push(rule);
  }
  return { present, future };
}
