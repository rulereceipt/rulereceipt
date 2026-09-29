import { classifyRules, type Classification } from "./checks/classify.js";
import { runDeterministicChecks } from "./checks/deterministicChecks.js";
import { runIfEditThenTestChecks } from "./checks/ifEditThenTest.js";
import { runGitBranchPolicyChecks } from "./checks/gitBranchPolicy.js";
import { runCodeContentChecks } from "./checks/codeContent.js";
import { runFileLifecycleChecks } from "./checks/fileLifecycle.js";
import { runClaimEvidenceChecks } from "./checks/claimEvidence.js";
import { runEmojiChecks } from "./checks/emojiOutput.js";
import { runAttributionChecks } from "./checks/attribution.js";
import { runApprovalGateChecks } from "./checks/approvalGate.js";
import { runJudgmentChecks } from "./checks/judgmentChecks.js";
import { touchedPaths, ruleWasLoaded } from "./checks/pathScope.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { partitionByAge, futureResult } from "./ruleAge.js";
import { loadOverrides, ruleFingerprint, staleOverrides } from "./overrides.js";
import type { CheckResult, Rule, TranscriptEvent } from "./types.js";

/**
 * `permissions.allow` from the Claude Code settings that apply here. A command
 * on this list runs without a prompt, so a push it covers had no chance of a
 * human "yes" — the approval check needs that to tell "maybe you clicked yes"
 * from "nobody was asked". Absent/unreadable files contribute nothing.
 */
function claudeAllowList(cwd: string): string[] {
  const out: string[] = [];
  for (const p of [join(cwd, ".claude", "settings.json"), join(cwd, ".claude", "settings.local.json"), join(homedir(), ".claude", "settings.json")]) {
    try {
      const allow = (JSON.parse(readFileSync(p, "utf-8")) as { permissions?: { allow?: unknown } }).permissions?.allow;
      if (Array.isArray(allow)) out.push(...allow.filter((x): x is string => typeof x === "string"));
    } catch {
      /* absent or unreadable: no allow entries from this file */
    }
  }
  return out;
}

export interface Evaluation {
  results: CheckResult[];
  notARule: Classification[];
  stale: ReturnType<typeof staleOverrides>;
}

/**
 * Rules in, verdicts out — the whole pipeline, with no printing in it.
 *
 * Extracted 2026-09-14 when a second caller appeared. `check` renders a
 * report for a person; `hook` returns a decision to Claude Code. Those two
 * must never be able to disagree about whether a rule was broken, and the
 * only way to guarantee that is one body of code. The same reasoning is
 * written at the top of testCommands.ts, about two checkers sharing one
 * definition; this is that argument one level up.
 *
 * Deliberately takes `events` rather than a path: the caller decides where
 * a transcript comes from, and a hook is handed one it must not second-guess.
 */
export async function evaluateSession(
  cwd: string,
  rules: Rule[],
  events: TranscriptEvent[],
  llm: boolean,
  needsLlmResult: (rule: Rule) => CheckResult,
): Promise<Evaluation> {
  const overrides = loadOverrides(cwd);
  const touched = touchedPaths(events);
  // A rule cannot have been broken by a session that ran before it existed.
  // Rules added after the session started (from git history) are reported as
  // not applicable, never checked. Fails open: no git history means nothing is
  // set aside. Moved here from `check` 2026-09-28 (the one-engine fix) so the
  // hook and report apply it too.
  const { present, future } = partitionByAge(cwd, rules, events);
  const classified = classifyRules(present).map((c) => {
    const decision = overrides.get(ruleFingerprint(c.rule))?.decision;
    if (!decision) return c;
    if (decision === "notARule") return { kind: "notARule" as const, rule: c.rule };
    return c.kind === "notARule" ? { kind: "judgment" as const, rule: c.rule } : c;
  });

  // A path-scoped rule (paths:/globs: frontmatter) is only loaded by the agent
  // once the session touches a matching file. One the session never touched is
  // reported not_applicable with the reason — never judged, so the report
  // still lists every rule. Over-matches toward "loaded" (see pathScope.ts),
  // so it can only ever REMOVE a false accusation, never hide a real one.
  const notLoaded = classified.filter(
    (c) => c.kind !== "notARule" && c.rule.paths && !ruleWasLoaded(c.rule.paths, touched)
  );
  const classifications = classified.filter((c) => !notLoaded.includes(c));
  const scopeResults: CheckResult[] = notLoaded.map(({ rule }) => ({
    ruleId: rule.id,
    ruleTitle: rule.title,
    ruleSource: rule.source,
    status: "UNCLEAR",
    outcome: "not_applicable",
    method: "file_events",
    reason: "path_scope_not_loaded",
    evidence: `path-scoped rule (${rule.paths!.join(", ")}): this session touched no matching file, so Claude never loaded it`,
  }));

  const of = (kind: Classification["kind"]) => classifications.filter((c) => c.kind === kind);

  const deterministicResults = [
    ...runDeterministicChecks(of("deterministic") as never, events),
    ...runIfEditThenTestChecks(of("ifEditThenTest") as never, events),
    ...runGitBranchPolicyChecks(of("gitBranchPolicy") as never, events),
    ...runCodeContentChecks(of("codeContent") as never, events),
    ...runFileLifecycleChecks(of("fileLifecycle") as never, events),
    ...runClaimEvidenceChecks(of("claimEvidence") as never, events),
    ...runEmojiChecks(of("emojiOutput") as never, events),
    ...runAttributionChecks(of("attribution") as never, events),
    ...runApprovalGateChecks(of("approvalGate") as never, events, { allow: claudeAllowList(cwd) }),
  ];

  const judgment = of("judgment");
  const judgmentResults = llm
    ? await runJudgmentChecks(judgment as never, events)
    : judgment.map(({ rule }) => needsLlmResult(rule));

  const results = [...deterministicResults, ...judgmentResults, ...scopeResults, ...future.map(futureResult)];

  return {
    results: attachSourceLocation(results, rules),
    notARule: of("notARule"),
    stale: staleOverrides(overrides, rules),
  };
}

/**
 * Copies each rule's source file/line onto its verdict — but ONLY when the
 * (source, id, title) triple maps to exactly one loaded rule. Rule ids are
 * positional and two files can legitimately reuse "1" or "S1.1", so a blind
 * id-match could point a report at the wrong line. A wrong "CLAUDE.md:42" is
 * worse than none, so an ambiguous or unlocated rule simply carries no line.
 */
function locationKey(source: string, id: string, title: string): string {
  return `${source}\u0000${id}\u0000${title}`;
}

export function attachSourceLocation(results: CheckResult[], rules: Rule[]): CheckResult[] {
  const byKey = new Map<string, Rule | null>();
  for (const rule of rules) {
    if (rule.sourcePath === undefined) continue;
    const key = locationKey(rule.source, rule.id, rule.title);
    byKey.set(key, byKey.has(key) ? null : rule); // second hit => ambiguous => null
  }
  return results.map((r) => {
    const rule = byKey.get(locationKey(r.ruleSource, r.ruleId, r.ruleTitle));
    if (!rule) return r;
    return { ...r, sourcePath: rule.sourcePath, sourceLine: rule.sourceLine };
  });
}
