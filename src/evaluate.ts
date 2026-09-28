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
import { loadOverrides, ruleFingerprint, staleOverrides } from "./overrides.js";
import type { CheckResult, Rule, TranscriptEvent } from "./types.js";

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
  const classified = classifyRules(rules).map((c) => {
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
    ...runApprovalGateChecks(of("approvalGate") as never, events),
  ];

  const judgment = of("judgment");
  const judgmentResults = llm
    ? await runJudgmentChecks(judgment as never, events)
    : judgment.map(({ rule }) => needsLlmResult(rule));

  return {
    results: [...deterministicResults, ...judgmentResults, ...scopeResults],
    notARule: of("notARule"),
    stale: staleOverrides(overrides, rules),
  };
}
