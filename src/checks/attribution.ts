import type { AttributionClassification } from "./classify.js";
import type { CheckResult, TranscriptEvent, TranscriptToolUseEvent } from "../types.js";
import { violation } from "../types.js";
import { withoutHeredocs } from "./shellCommand.js";

/**
 * Did the session add an AI-attribution trailer to a commit, PR or comment,
 * against a rule forbidding it?
 *
 * Raised by anthropics/claude-code#83813, #92169, #82690 and #4287: a user
 * writes "no Co-Authored-By, no 'Generated with Claude Code'" into their
 * rules file, and the trailer lands on the commit anyway. It is one of the
 * most-filed rule-following complaints, and it is mechanically checkable —
 * the trailer is literal text that sits in the git command the assistant
 * ran.
 *
 * Scope is deliberately narrow, for the same reason emojiOutput reads only
 * assistant text: a rule that FORBIDS attribution necessarily quotes the
 * exact trailer it forbids ("never add `Co-Authored-By: Claude`"), and this
 * repo's own CLAUDE.md does exactly that. Scanning rule text, user text, or
 * a plain `cat` of a file would fire on the prohibition itself. So this
 * looks at one thing only: the text of a git-writing command the ASSISTANT
 * issued — `git commit`, `gh pr create`, a PR or issue comment — and asks
 * whether the forbidden trailer is inside it.
 *
 * The ceiling that travels with the verdict is the honest limit: a trailer
 * the harness appends OUTSIDE the recorded command text (the #83813
 * mechanism, where the platform adds it) is not visible in the transcript,
 * so a PASS means "not in any command recorded here", never "no attribution
 * reached the commit".
 */

/** Commands that write to git history or to GitHub on the author's behalf. */
// `git\s+…\s+commit` allows config flags between the two — `git -c
// user.name=x commit`, `git --no-pager commit` — which a literal `git commit`
// missed (found by an evasion probe, 2026-09-22). Up to four intervening
// tokens, and `commit` not followed by a word char so `commit-graph` is not
// a commit. Same shape for the push detector in approvalGate.
const GIT_WRITE =
  /\bgit\s+(?:\S+\s+){0,4}?commit(?![\w-])|\bgit\s+.*--amend\b|\bgh\s+pr\s+(?:create|edit|review|comment)\b|\bgh\s+issue\s+(?:create|comment)\b|\bgh\s+api\b[^\n]*\bcomments?\b/i;

/**
 * The forbidden trailers, as literal spellings. Each is an AI-authorship
 * mark, not merely the word "Claude" (a commit may legitimately say "fix the
 * Claude Code parser"): the co-author trailer, the generated-with line with
 * or without its robot, and the anthropic noreply address used as an author.
 */
const ATTRIBUTION_TRAILER =
  /co-?authored-by:\s*[^\n]*(?:claude|anthropic)|generated with\s*\[?\s*claude code|🤖\s*generated with|<?noreply@anthropic\.com>?/i;

function commandText(event: TranscriptToolUseEvent): string {
  const input = event.input as { command?: unknown } | null;
  return input && typeof input.command === "string" ? input.command : "";
}

/** The first git-writing command in the session that carries a trailer. */
function firstOffendingCommand(events: TranscriptEvent[]): string | null {
  let sawGitWrite = false;
  for (const event of events) {
    if (event.kind !== "tool_use" || event.toolName !== "Bash") continue;
    const command = commandText(event);
    // Prove git is actually INVOKED, not merely quoted: a `cat <<EOF … git
    // commit … Co-Authored-By … EOF` writes a file that contains the example,
    // it does not commit. Strip heredoc bodies before testing the invocation,
    // but match the trailer against the FULL command so a real heredoc that
    // FEEDS the commit message is still caught.
    if (!GIT_WRITE.test(withoutHeredocs(command))) continue;
    sawGitWrite = true;
    if (ATTRIBUTION_TRAILER.test(command)) return command;
  }
  return sawGitWrite ? "" : null;
}

export function runAttributionChecks(
  classifications: AttributionClassification[],
  events: TranscriptEvent[]
): CheckResult[] {
  const offending = firstOffendingCommand(events);

  return classifications.map(({ rule, polarity }) => {
    if (typeof offending === "string" && offending.length > 0) {
      const m = offending.match(ATTRIBUTION_TRAILER);
      const at = m?.index ?? 0;
      const excerpt = offending
        .slice(Math.max(0, at - 30), at + 50)
        .replace(/\s+/g, " ")
        .trim();
      return violation(
        rule,
        polarity,
        `a git/PR command carried an AI-attribution trailer — "…${excerpt}…"`,
        {
          method: "attribution_scan",
          ceiling:
            "reads the text of git/PR commands recorded in the transcript; a trailer the harness appends outside the recorded command is not visible here",
        }
      );
    }

    if (offending === null) {
      return {
        ruleId: rule.id,
        ruleTitle: rule.title,
        ruleSource: rule.source,
        status: "PASS" as const,
        outcome: "not_applicable" as const,
        method: "attribution_scan" as const,
        evidence:
          "no commit, PR or comment was created this session, so there was nothing to attribute",
        ceiling: "a scan of the git/PR commands recorded in this transcript",
      };
    }

    return {
      ruleId: rule.id,
      ruleTitle: rule.title,
      ruleSource: rule.source,
      status: "PASS" as const,
      outcome: "pass" as const,
      method: "attribution_scan" as const,
      evidence: "the git/PR commands this session ran carried no AI-attribution trailer",
      ceiling:
        "reads the text of git/PR commands recorded in the transcript; a trailer the harness appends outside the recorded command is not visible here",
    };
  });
}
