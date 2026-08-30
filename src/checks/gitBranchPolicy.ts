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
// Split from a single "checkout or switch" pattern: `checkout -b`/`switch
// -c` CREATE a new branch with that exact name — nobody accidentally
// creates a branch named exactly the protected name while trying to sync
// something else, so this is an immediate hit, same as GIT_BRANCH_CREATE.
// A bare `checkout`/`switch` (no -b/-c) only SWITCHES to an existing
// branch, which is routine (syncing before branching off) and only
// becomes a real violation if a commit follows it — see
// findCheckoutCommitViolation.
const GIT_CHECKOUT_CREATE = /\bgit\s+(?:checkout\s+-[bB]|switch\s+-c)\s+([^\s-][^\s]*)/;
const GIT_CHECKOUT_SWITCH_ONLY = /\bgit\s+(?:checkout|switch)\s+(?:--\s+)?([^\s-][^\s]*)/;
const GIT_BRANCH_CREATE = /\bgit\s+branch\s+(?:-[a-zA-Z]+\s+)?([^\s-][^\s]*)/;
const GIT_PUSH = /\bgit\s+push\s+(?:\S+\s+)?(?:\+)?(?:[^\s:]+:)?([^\s:]+)\s*$/;
const GIT_COMMIT = /\bgit\s+commit\b/;

function extractGitBranchTargets(command: string): string[] {
  const targets: string[] = [];
  for (const regex of [GIT_CHECKOUT_CREATE, GIT_CHECKOUT_SWITCH_ONLY, GIT_BRANCH_CREATE, GIT_PUSH]) {
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

/**
 * Real gap found 2026-08-30, one publish after the first version of this
 * file shipped: the original version treated ANY checkout of the named
 * branch as a violation — but "git checkout sprint && git pull origin
 * sprint" (sync, then branch off) is normal, compliant workflow, not a
 * violation of "never work on the sprint branch." The actual violation is
 * COMMITTING while that branch is checked out, not merely visiting it.
 * Simulates the current checked-out branch across the session in
 * chronological order, and only counts a checkout-based hit when a real
 * `git commit` happens while that branch is current. Push/branch-create
 * targeting the named branch stay immediate hits regardless — pushing
 * straight to a protected branch, or creating/renaming/deleting it, is
 * the violation itself, not something that needs a following commit.
 */
function findCheckoutCommitViolation(commands: string[], branchName: string): string | null {
  let currentBranch: string | null = null;
  for (const command of commands) {
    const checkoutMatch = command.match(GIT_CHECKOUT_CREATE) ?? command.match(GIT_CHECKOUT_SWITCH_ONLY);
    if (checkoutMatch) {
      currentBranch = checkoutMatch[1];
      continue;
    }
    if (currentBranch === branchName && GIT_COMMIT.test(command)) {
      return command;
    }
  }
  return null;
}

export function runGitBranchPolicyChecks(
  classifications: GitBranchPolicyClassification[],
  events: TranscriptEvent[]
): CheckResult[] {
  const commands: string[] = [];
  const allTargets: { branch: string; command: string }[] = [];
  for (const event of events) {
    const command = commandFromEvent(event);
    if (!command) continue;
    commands.push(command);
    for (const branch of extractGitBranchTargets(command)) {
      allTargets.push({ branch, command });
    }
  }

  return classifications.map(({ rule, branchName, polarity }) => {
    const pushOrCreateHit = allTargets.find(
      (t) =>
        t.branch === branchName &&
        (GIT_PUSH.test(t.command) || GIT_BRANCH_CREATE.test(t.command) || GIT_CHECKOUT_CREATE.test(t.command))
    );
    const commitViolationCommand = findCheckoutCommitViolation(commands, branchName);
    const hit = pushOrCreateHit ?? (commitViolationCommand ? { branch: branchName, command: commitViolationCommand } : undefined);

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
