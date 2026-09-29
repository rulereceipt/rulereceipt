import { parseTranscriptText } from "../parsers/transcriptLine.js";
import { parseClaudeMdText } from "../parsers/claudeMdParser.js";
import { classifyRules, type Classification } from "../checks/classify.js";
import { runDeterministicChecks } from "../checks/deterministicChecks.js";
import { runIfEditThenTestChecks } from "../checks/ifEditThenTest.js";
import { runGitBranchPolicyChecks } from "../checks/gitBranchPolicy.js";
import { runCodeContentChecks } from "../checks/codeContent.js";
import { runFileLifecycleChecks } from "../checks/fileLifecycle.js";
import { runClaimEvidenceChecks } from "../checks/claimEvidence.js";
import { runEmojiChecks } from "../checks/emojiOutput.js";
import { runAttributionChecks } from "../checks/attribution.js";
import { runApprovalGateChecks } from "../checks/approvalGate.js";
import { touchedPaths, ruleWasLoaded } from "../checks/pathScope.js";
import { downgradeUserAsked } from "../checks/userAsked.js";
import type { CheckResult } from "../types.js";

/**
 * Evaluate a session against rules ENTIRELY in the browser — the same checkers
 * the CLI uses, run on a file the user dropped, with nothing leaving the page.
 *
 * This is the CLI's evaluateSession minus the parts that need a machine: no
 * saved overrides, no git rule-age split, no reading the user's settings.json
 * for a permissions.allow list (so the approval check runs with an empty allow
 * list — it can only be MORE cautious, never less). Everything reachable from
 * here is pure string work; keep it that way so the site's "your file never
 * leaves this page" promise stays true. Judgment rules report UNCLEAR (no LLM
 * call), exactly as `check` without `--llm` does.
 */
export function evaluateBrowserSession(rulesText: string, sessionText: string): CheckResult[] {
  const rules = parseClaudeMdText(rulesText, "project");
  const events = parseTranscriptText(sessionText);
  const touched = touchedPaths(events);
  const classified = classifyRules(rules);

  // A path-scoped rule the session never touched a matching file for was never
  // loaded by the agent, so it is reported not-applicable rather than judged.
  const notLoaded = classified.filter((c) => c.kind !== "notARule" && c.rule.paths && !ruleWasLoaded(c.rule.paths, touched));
  const classifications = classified.filter((c) => !notLoaded.includes(c));
  const scopeResults: CheckResult[] = notLoaded.map(({ rule }) => ({
    ruleId: rule.id,
    ruleTitle: rule.title,
    ruleSource: rule.source,
    status: "UNCLEAR",
    outcome: "not_applicable",
    method: "file_events",
    reason: "path_scope_not_loaded",
    evidence: `path-scoped rule (${rule.paths!.join(", ")}): this session touched no matching file, so it was never loaded`,
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
    ...runApprovalGateChecks(of("approvalGate") as never, events, { allow: [] }),
  ];

  const judgmentResults: CheckResult[] = of("judgment").map(({ rule }) => ({
    ruleId: rule.id,
    ruleTitle: rule.title,
    ruleSource: rule.source,
    status: "UNCLEAR",
    needsHuman: true,
    evidence: "",
  }));

  const structural = downgradeUserAsked(deterministicResults, classifications, events);
  return [...structural, ...judgmentResults, ...scopeResults];
}

export interface BrowserSessionSummary {
  results: CheckResult[];
  pass: number;
  fail: number;
  unclear: number;
  events: number;
}

/** The whole client-side session check: parse, evaluate, and count. */
export function checkSessionInBrowser(rulesText: string, sessionText: string): BrowserSessionSummary {
  const results = evaluateBrowserSession(rulesText, sessionText);
  const count = (s: CheckResult["status"]) => results.filter((r) => r.status === s).length;
  return {
    results,
    pass: count("PASS"),
    fail: count("FAIL"),
    unclear: count("UNCLEAR"),
    events: parseTranscriptText(sessionText).length,
  };
}
