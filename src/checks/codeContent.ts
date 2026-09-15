import type { TranscriptEvent, CheckResult } from "../types.js";
import { violation } from "../types.js";
import type { CodeContentClassification } from "./classify.js";

/**
 * Second structured-check primitive: only scans the actual content of
 * real file edits for a code-construct pattern (e.g. `print(`,
 * `analytics.track(`) — never a Bash command string, never prose, never
 * tool_result. Real false-positive this fixes (found 2026-08-30, on the
 * same real session as the git-branch bug): even after excluding
 * tool_result from the generic deterministic check, a rule like "no
 * `print(` statements" still matched because the agent's own Bash
 * command MENTIONED the pattern as a search argument (e.g. `grep -rn
 * "print(" src/`) — no print statement was ever written into a file.
 *
 * Known, stated limitation: `content`/`new_string` are the confirmed
 * real field names for Write/Edit tool_use input; NotebookEdit's field
 * name is included as best-effort (not independently confirmed against a
 * real NotebookEdit transcript event before shipping this) — a session
 * that only writes matching code via NotebookEdit could under-report,
 * which fails toward UNCLEAR/PASS, not a fabricated FAIL.
 */
function editedContentFromEvent(event: TranscriptEvent): string | null {
  if (event.kind !== "tool_use") return null;
  const input = event.input as { content?: unknown; new_string?: unknown; new_source?: unknown };
  if (event.toolName === "Write" && typeof input?.content === "string") return input.content;
  if (event.toolName === "Edit" && typeof input?.new_string === "string") return input.new_string;
  if (event.toolName === "NotebookEdit" && typeof input?.new_source === "string") return input.new_source;
  return null;
}

/**
 * Whether the content contains this literal AS A CALL, not merely as a
 * substring of a longer identifier.
 *
 * Found 2026-09-15 by checking a corpus FAIL rather than assuming it was
 * legitimate: a rule forbidding `fetch()` matched a file containing
 * `_metar_fetch()`. The literal was present verbatim, and entirely the wrong
 * function. The same bare-substring test makes `main()` match `domain()` and
 * `run()` match `rerun()`, and short generic call names are exactly what
 * these rules tend to name.
 *
 * Only the LEADING boundary is checked. The trailing side is already pinned
 * by the pattern itself — every literal reaching this checker ends in an
 * open paren or a call — so requiring a boundary after it would reject the
 * arguments.
 */
function containsCall(content: string, pattern: string): boolean {
  const leadsWithIdentifier = /^[A-Za-z0-9_$]/.test(pattern);
  if (!leadsWithIdentifier) return content.includes(pattern);
  let from = 0;
  for (;;) {
    const at = content.indexOf(pattern, from);
    if (at === -1) return false;
    const before = at === 0 ? "" : content[at - 1];
    if (!/[A-Za-z0-9_$.]/.test(before)) return true;
    from = at + 1;
  }
}

export function runCodeContentChecks(
  classifications: CodeContentClassification[],
  events: TranscriptEvent[]
): CheckResult[] {
  const editedContents: string[] = [];
  for (const event of events) {
    const content = editedContentFromEvent(event);
    if (content) editedContents.push(content);
  }

  return classifications.map(({ rule, patterns, polarity, polarityInferred }) => {
    let foundPattern: string | undefined;
    let foundContent: string | undefined;
    for (const content of editedContents) {
      for (const pattern of patterns) {
        if (containsCall(content, pattern)) {
          foundPattern = pattern;
          foundContent = content;
          break;
        }
      }
      if (foundPattern) break;
    }

    if (polarity === "forbid") {
      if (foundPattern && foundContent) {
        return violation(rule, polarity, `found "${foundPattern}" actually written into a file: ${foundContent.slice(0, 160)}`, { method: "code_content", polarityInferred });
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
        method: "code_content" as const,
        ceiling: "a scan of content written through Write/Edit — it does not see content written by a shell command",
        evidence: `no file edit actually contained ${patterns.map((p) => `"${p}"`).join(" or ")} this session`,
      };
    }

    // require: absence is UNCLEAR, not a fabricated FAIL — same reasoning
    // as deterministicChecks.ts's require-polarity handling
    if (foundPattern && foundContent) {
      return {
        ruleId: rule.id,
        ruleTitle: rule.title,
        ruleSource: rule.source,
        status: "PASS",
        evidence: `found required "${foundPattern}" actually written into a file: ${foundContent.slice(0, 160)}`,
      };
    }
    return {
      ruleId: rule.id,
      ruleTitle: rule.title,
      ruleSource: rule.source,
      status: "UNCLEAR",
      evidence: `no file edit contained the required ${patterns.map((p) => `"${p}"`).join(" or ")} this session — can't tell if the rule didn't apply, or applied and was skipped`,
    };
  });
}
