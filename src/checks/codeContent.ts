import type { TranscriptEvent, CheckResult } from "../types.js";
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

export function runCodeContentChecks(
  classifications: CodeContentClassification[],
  events: TranscriptEvent[]
): CheckResult[] {
  const editedContents: string[] = [];
  for (const event of events) {
    const content = editedContentFromEvent(event);
    if (content) editedContents.push(content);
  }

  return classifications.map(({ rule, patterns, polarity }) => {
    let foundPattern: string | undefined;
    let foundContent: string | undefined;
    for (const content of editedContents) {
      for (const pattern of patterns) {
        if (content.includes(pattern)) {
          foundPattern = pattern;
          foundContent = content;
          break;
        }
      }
      if (foundPattern) break;
    }

    if (polarity === "forbid") {
      if (foundPattern && foundContent) {
        return {
          ruleId: rule.id,
          ruleTitle: rule.title,
          ruleSource: rule.source,
          status: "FAIL",
          evidence: `found "${foundPattern}" actually written into a file: ${foundContent.slice(0, 160)}`,
        };
      }
      return {
        ruleId: rule.id,
        ruleTitle: rule.title,
        ruleSource: rule.source,
        status: "PASS",
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
