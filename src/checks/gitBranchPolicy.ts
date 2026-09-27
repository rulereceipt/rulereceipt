import type { TranscriptEvent, CheckResult } from "../types.js";
import { violation } from "../types.js";
import type { GitBranchPolicyClassification } from "./classify.js";
import { segments, leadingCommand } from "./shellCommand.js";

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
// A bare switch to an existing branch. NOTE: no `(?:--\s+)?` here — `git
// checkout -- <path>` restores a FILE (the `--` means "pathspec, not ref"),
// and reading that path as a branch caused a false FAIL when a file shared the
// protected branch's name (finding 2026-09-26).
const GIT_CHECKOUT_SWITCH_ONLY = /\bgit\s+(?:checkout|switch)\s+([^\s-][^\s]*)/;
const GIT_COMMIT = /\bgit\s+commit\b/;

// Locates the args after a `git … push`, allowing config flags between `git`
// and `push` (`git -c x=y push …`), the same shape as the other detectors.
const GIT_PUSH_ARGS = /\bgit\s+(?:\S+\s+){0,4}?push(?![\w-])\s*(.*)$/;
const GIT_BRANCH_ARGS = /\bgit\s+(?:\S+\s+){0,4}?branch(?![\w-])\s*(.*)$/;

type BranchHit = { branch: string; kind: "push" | "create" | "switch" };

/**
 * The branch(es) a `git push` actually writes to. Parses the args instead of
 * a single end-anchored regex, so it catches every real form the old GIT_PUSH
 * missed: force-push, `-u`, a flag AFTER the branch, `--force-with-lease`, a
 * remote-branch delete (`origin :main`, `origin --delete main`), and a
 * `local:remote` refspec (the TARGET is the remote side).
 */
function pushTargets(command: string): string[] {
  const out: string[] = [];
  for (const seg of segments(command)) {
    if (leadingCommand(seg) !== "git") continue;
    const m = seg.match(GIT_PUSH_ARGS);
    if (!m || m[1].trim().length === 0) continue; // bare `git push`: branch unknown
    const tokens = m[1].trim().split(/\s+/).filter(Boolean);
    const positionals = tokens.filter((t) => !t.startsWith("-"));
    // First positional is the remote; every later one is a refspec.
    for (const ref of positionals.slice(1)) {
      const spec = ref.replace(/^\+/, ""); // `+local:remote` force refspec
      const colon = spec.indexOf(":");
      const target = colon >= 0 ? spec.slice(colon + 1) : spec; // remote side
      if (target.length > 0) out.push(target);
    }
  }
  return out;
}

/**
 * The branch(es) a `git branch` command creates, deletes, or renames INTO.
 * `-m/-M/--move <old> <new>` targets the NEW name (last positional — a rename
 * into `main` overwrites `main`); `-d/-D/--delete` targets every named branch;
 * a plain `git branch <name> [<start>]` targets only the created <name>.
 */
function branchTargets(command: string): string[] {
  const out: string[] = [];
  for (const seg of segments(command)) {
    if (leadingCommand(seg) !== "git") continue;
    const m = seg.match(GIT_BRANCH_ARGS);
    if (!m || m[1].trim().length === 0) continue;
    const tokens = m[1].trim().split(/\s+/).filter(Boolean);
    const flags = tokens.filter((t) => t.startsWith("-"));
    const positionals = tokens.filter((t) => !t.startsWith("-"));
    if (positionals.length === 0) continue;
    if (flags.some((f) => /^(?:--move|-m|-M)$/.test(f))) {
      out.push(positionals[positionals.length - 1]);
    } else if (flags.some((f) => /^(?:--delete|-d|-D)$/.test(f))) {
      out.push(...positionals);
    } else {
      out.push(positionals[0]);
    }
  }
  return out;
}

function extractGitBranchTargets(command: string): BranchHit[] {
  const hits: BranchHit[] = [];
  const create = command.match(GIT_CHECKOUT_CREATE);
  if (create) hits.push({ branch: create[1], kind: "create" });
  const switchOnly = command.match(GIT_CHECKOUT_SWITCH_ONLY);
  if (switchOnly) hits.push({ branch: switchOnly[1], kind: "switch" });
  for (const b of branchTargets(command)) hits.push({ branch: b, kind: "create" });
  for (const b of pushTargets(command)) hits.push({ branch: b, kind: "push" });
  return hits;
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
  const allTargets: { branch: string; command: string; kind: BranchHit["kind"] }[] = [];
  for (const event of events) {
    const command = commandFromEvent(event);
    if (!command) continue;
    commands.push(command);
    for (const hit of extractGitBranchTargets(command)) {
      allTargets.push({ branch: hit.branch, command, kind: hit.kind });
    }
  }

  const anyGitCommand = events.some(
    (e) => e.kind === "tool_use" && /\bgit\s/.test(JSON.stringify(e.input ?? ""))
  );
  return classifications.map(({ rule, branchName, polarity, polarityInferred }) => {
    // No git command ran, so a git rule never had a situation to govern.
    // Calling that "followed" is how an empty session produced 2,770 green
    // ticks across the 559-file corpus — every one true, none meaningful.
    if (!anyGitCommand) {
      return {
        ruleId: rule.id,
        ruleTitle: rule.title,
        ruleSource: rule.source,
        status: "UNCLEAR" as const,
        outcome: "not_applicable" as const,
        method: "git_events" as const,
        evidence: "no git command ran this session, so this rule never applied",
      };
    }
    // Push, branch-create/delete/rename, and checkout -b are immediate hits.
    // A bare `switch` is not — it only violates if a commit follows (below).
    const pushOrCreateHit = allTargets.find(
      (t) => t.branch === branchName && (t.kind === "push" || t.kind === "create")
    );
    const commitViolationCommand = findCheckoutCommitViolation(commands, branchName);
    const hit = pushOrCreateHit ?? (commitViolationCommand ? { branch: branchName, command: commitViolationCommand } : undefined);

    if (polarity === "forbid") {
      if (hit) {
        return violation(rule, polarity, `a git command actually targeted the "${branchName}" branch: ${hit.command}`, { method: "git_events", polarityInferred });
      }
        // Trigger evaluated and absent: the rule never applied. Not
        // "followed" — that word claims something the check cannot show.
      return {
        ruleId: rule.id,
        ruleTitle: rule.title,
        ruleSource: rule.source,
        // status stays UNCLEAR: a legacy reader must not see a green
        // tick for a rule that never applied. Setting PASS here while the
        // outcome said not_applicable was the same word-borrowing this
        // vocabulary exists to stop, one field further down.
        status: "UNCLEAR",
        outcome: "not_applicable" as const,
        method: "git_events" as const,
        ceiling: "a scan of recorded git commands — it does not see commands run outside this session",
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
