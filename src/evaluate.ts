import { classifyRules, type Classification } from "./checks/classify.js";
import { runDeterministicChecks } from "./checks/deterministicChecks.js";
import { runIfEditThenTestChecks } from "./checks/ifEditThenTest.js";
import { runGitBranchPolicyChecks } from "./checks/gitBranchPolicy.js";
import { runCodeContentChecks } from "./checks/codeContent.js";
import { runFileLifecycleChecks } from "./checks/fileLifecycle.js";
import { runClaimEvidenceChecks } from "./checks/claimEvidence.js";
import { runJudgmentChecks } from "./checks/judgmentChecks.js";
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
  const classifications = classifyRules(rules).map((c) => {
    const decision = overrides.get(ruleFingerprint(c.rule))?.decision;
    if (!decision) return c;
    if (decision === "notARule") return { kind: "notARule" as const, rule: c.rule };
    return c.kind === "notARule" ? { kind: "judgment" as const, rule: c.rule } : c;
  });

  const of = (kind: Classification["kind"]) => classifications.filter((c) => c.kind === kind);

  const deterministicResults = [
    ...runDeterministicChecks(of("deterministic") as never, events),
    ...runIfEditThenTestChecks(of("ifEditThenTest") as never, events),
    ...runGitBranchPolicyChecks(of("gitBranchPolicy") as never, events),
    ...runCodeContentChecks(of("codeContent") as never, events),
    ...runFileLifecycleChecks(of("fileLifecycle") as never, events),
    ...runClaimEvidenceChecks(of("claimEvidence") as never, events),
  ];

  const judgment = of("judgment");
  const judgmentResults = llm
    ? await runJudgmentChecks(judgment as never, events)
    : judgment.map(({ rule }) => needsLlmResult(rule));

  return {
    results: [...deterministicResults, ...judgmentResults],
    notARule: of("notARule"),
    stale: staleOverrides(overrides, rules),
  };
}
