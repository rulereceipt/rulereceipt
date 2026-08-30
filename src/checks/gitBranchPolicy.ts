import type { TranscriptEvent, CheckResult } from "../types.js";
import type { GitBranchPolicyClassification } from "./classify.js";

/**
 * First real structured-check primitive: parses actual git command
 * arguments instead of searching prose for a branch name as a substring.
 * Real bug this fixes (found 2026-08-30): a rule like "never touch the
 * `demo` branch" previously matched the word "demo" appearing ANYWHERE —
 * a repo name ("acme demo repo"), a directory, an unrelated sentence.
 * This only matches an actual git command whose branch ARGUMENT is
 * exactly the named branch.
 *
 * Known, stated limitation: covers the common real invocations
 * (checkout, switch, branch create/delete/rename, push to a branch) via
 * regex on the command string, not a real git-command-line parser. Things
 * this does NOT reliably cover: `git checkout <ref>` when <ref> could be
 * a file path rather than a branch (ambiguous without actually running
 * git), refspecs with `+`/wildcards, `git rebase --onto <branch>`, and
 * any git GUI/porcelain wrapper that doesn't literally run `git` in Bash.
 * Failing to detect a real violation here is a false negative (UNCLEAR),
 * which is the safe direction — this must never fabricate a FAIL from a
 * command that didn't actually target the named branch.
 */
const GIT_CHECKOUT_OR_SWITCH = /\bgit\s+(?:checkout|switch)\s+(?:-[bcB]\s+)?(?:--\s+)?([^\s-][^\s]*)/;
const GIT_BRANCH_CREATE = /\bgit\s+branch\s+(?:-[a-zA-Z]+\s+)?([^\s-][^\s]*)/;
const GIT_PUSH = /\bgit\s+push\s+(?:\S+\s+)?(?:\+)?(?:[^\s:]+:)?([^\s:]+)\s*$/;

function extractGitBranchTargets(command: string): string[] {
  const targets: string[] = [];
  for (const regex of [GIT_CHECKOUT_OR_SWITCH, GIT_BRANCH_CREATE, GIT_PUSH]) {
    const match = command.match(regex);
    if (match) targets.push(match[1]);
  }
  return targets;
}

function commandFromEvent(event: TranscriptEvent): string | null {
  if (event.kind !== "tool_use" || event.toolName !== "Bash") return null;
  const input = event.input as { command?: unknown };
  return typeof input?.command === "string" ? input.command : null;
}

export function runGitBranchPolicyChecks(
  classifications: GitBranchPolicyClassification[],
  events: TranscriptEvent[]
): CheckResult[] {
  const allTargets: { branch: string; command: string }[] = [];
  for (const event of events) {
    const command = commandFromEvent(event);
    if (!command) continue;
    for (const branch of extractGitBranchTargets(command)) {
      allTargets.push({ branch, command });
    }
  }

  return classifications.map(({ rule, branchName, polarity }) => {
    const hit = allTargets.find((t) => t.branch === branchName);

    if (polarity === "forbid") {
      if (hit) {
        return {
          ruleId: rule.id,
          ruleTitle: rule.title,
          ruleSource: rule.source,
          status: "FAIL",
          evidence: `a git command actually targeted the "${branchName}" branch: ${hit.command}`,
        };
      }
      return {
        ruleId: rule.id,
        ruleTitle: rule.title,
        ruleSource: rule.source,
        status: "PASS",
        evidence: `no git command targeted the "${branchName}" branch this session`,
      };
    }

    // require: absence is UNCLEAR, not a fabricated FAIL — same reasoning
    // as deterministicChecks.ts's require-polarity handling
    if (hit) {
      return {
        ruleId: rule.id,
        ruleTitle: rule.title,
        ruleSource: rule.source,
        status: "PASS",
        evidence: `a git command targeted the required "${branchName}" branch: ${hit.command}`,
      };
    }
    return {
      ruleId: rule.id,
      ruleTitle: rule.title,
      ruleSource: rule.source,
      status: "UNCLEAR",
      evidence: `no git command targeting the "${branchName}" branch appeared this session — can't tell if the rule didn't apply, or applied and was skipped`,
    };
  });
}
