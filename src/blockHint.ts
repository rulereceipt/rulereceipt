import type { Classification } from "./checks/classify.js";

/**
 * `why` answers "why isn't THIS rule working?". For a rule that names a
 * concrete action, the honest follow-up is "then how do I actually stop it?".
 * This computes that answer — and it is deliberately pinned to what the tool
 * really does, because an overstated "add this and you're safe" is exactly the
 * failure RuleReceipt exists to catch.
 *
 * Two facts, kept separate because they are not the same promise:
 *
 *  - `guardCovers`: RuleReceipt's own PreToolUse guard refuses this exact rule
 *    before the action runs. True only for the kinds guardDecision/structuredBlocks
 *    actually handle (a branch, a file, forbidden file content, an AI-authorship
 *    trailer) and for an approval gate (which it answers "ask", or "deny" in a
 *    no-prompt mode). It is NOT a general command blocker — that was measured and
 *    cut (see guard.ts), so nothing here claims it.
 *
 *  - `native`: a Claude Code `permissions` entry the user can add by hand with no
 *    extra tool. Only emitted where a permission rule can genuinely express the
 *    thing, and always with the honest caveat: a permission rule matches the
 *    command text or the file path, so it cannot scope to a branch, cannot read a
 *    commit message, and cannot see file content. Where it can't express the rule,
 *    `nativeImpossibleReason` says so instead of inventing a rule that wouldn't fire.
 *
 * `preventable: false` is the honest answer for the rest: a claim-evidence rule,
 * an emoji rule, an edit-implies-test rule, a plain literal rule — these are judged
 * AFTER the run, not blockable before an action. The caller points at `check` and
 * the Stop hook instead.
 */

export interface BlockHint {
  /** Can an action be refused BEFORE it runs (guard or a native deny/ask)? */
  preventable: boolean;
  /** Does RuleReceipt's own guard (`rulereceipt protect`) check this exact rule pre-flight? */
  guardCovers: boolean;
  /** A native Claude Code permissions entry, where one can genuinely express the rule. */
  native?: { kind: "deny" | "ask"; entries: string[]; note: string };
  /** When preventable but a native permission rule cannot express it, why. */
  nativeImpossibleReason?: string;
}

/** Map an approval-gate action to the Claude Code permission pattern that matches it. */
function askEntryFor(action: string): string | undefined {
  switch (action) {
    case "push": return "Bash(git push:*)";
    case "commit": return "Bash(git commit:*)";
    case "pr": return "Bash(gh pr:*)";
    case "delete": return "Bash(rm:*)";
    default: return undefined;
  }
}

/**
 * The block advice for one classified rule, or undefined when there is nothing
 * useful to say (a judgment rule or a non-rule — the "needs your judgment" line
 * already covers those).
 */
export function blockHintFor(cls: Classification): BlockHint | undefined {
  switch (cls.kind) {
    case "gitBranchPolicy": {
      if (cls.polarity !== "forbid") return { preventable: false, guardCovers: false };
      return {
        preventable: true,
        guardCovers: true,
        native: {
          kind: "deny",
          entries: ["Bash(git push:*)"],
          note:
            `a permission rule matches the command text, so this denies EVERY push — it can't ` +
            `scope to the \`${cls.branchName}\` branch. The guard below checks the actual target branch.`,
        },
      };
    }

    case "fileLifecycle": {
      if (cls.polarity !== "forbid") return { preventable: false, guardCovers: false };
      return {
        preventable: true,
        guardCovers: true,
        native: {
          kind: "deny",
          entries: [`Edit(${cls.filePath})`, `Write(${cls.filePath})`],
          note:
            `covers Edit/Write of that path; a Bash \`rm\`/\`mv\` targeting it is NOT matched by ` +
            `these — the guard below covers those too.`,
        },
      };
    }

    case "approvalGate": {
      const entries = cls.actions.map(askEntryFor).filter((e): e is string => e !== undefined);
      if (entries.length === 0) return { preventable: true, guardCovers: true, nativeImpossibleReason: "the action it gates isn't one a permission rule can match" };
      return {
        preventable: true,
        guardCovers: true,
        native: {
          kind: "ask",
          entries,
          note:
            `an "ask" is skipped in no-prompt modes (bypassPermissions / auto), so the action would ` +
            `run there without a prompt. The guard below denies it in those modes instead.`,
        },
      };
    }

    case "attribution":
      return {
        preventable: true,
        guardCovers: true,
        nativeImpossibleReason: "a permission rule can't read a commit message, so it can't catch an AI-authorship trailer",
      };

    case "codeContent": {
      if (cls.polarity !== "forbid") return { preventable: false, guardCovers: false };
      return {
        preventable: true,
        guardCovers: true,
        nativeImpossibleReason: "a permission rule matches the command or path, not the content written into a file",
      };
    }

    case "claimEvidence":
    case "ifEditThenTest":
    case "emojiOutput":
    case "deterministic":
      // Checkable, but only after the run — there is no single action to refuse
      // beforehand. The caller points at `check` and the Stop hook.
      return { preventable: false, guardCovers: false };

    default:
      // judgment, notARule — nothing mechanical to block or check.
      return undefined;
  }
}
