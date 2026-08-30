import type { TranscriptEvent, CheckResult } from "../types.js";
import type { IfEditThenTestClassification } from "./classify.js";

const TEST_FILE_PATTERN = /(\.test\.|\.spec\.|__tests__\/|_test\.|\/tests?\/)/i;

const WRITE_LIKE_TOOLS = new Set(["Write", "Edit", "NotebookEdit"]);

function extractEditedPaths(events: TranscriptEvent[]): string[] {
  const paths: string[] = [];
  for (const event of events) {
    if (event.kind !== "tool_use") continue;
    if (!WRITE_LIKE_TOOLS.has(event.toolName)) continue;
    const input = event.input as { file_path?: unknown };
    if (typeof input?.file_path === "string") {
      paths.push(input.file_path);
    }
  }
  return paths;
}

/**
 * Checks "add tests for every change"-style rules by looking at which
 * files were actually edited, not what the assistant claimed in chat -
 * chat text is never evidence here, only Write/Edit tool_use events with
 * a real file_path (confirmed against a real session file's actual
 * field name before writing this, not assumed).
 *
 * Known, stated limitation: only covers Write/Edit/NotebookEdit tool
 * calls, not Bash-based writes (`cat >`, `tee`, `sed -i`) - unlike the
 * forbid/require pattern checks, which happen to catch Bash writes as a
 * side effect of scanning full stringified event text, this check needs
 * actual structured file paths to categorize prod-vs-test, and a Bash
 * command string doesn't reliably give that. A session that only wrote
 * code via Bash will under-report edits here, not over-report a false
 * "followed" - failing toward UNCLEAR/no-prod-edit-detected is the safe
 * direction, but it's a real gap worth fixing before this is marketed as
 * complete Bash-write coverage.
 */
export function runIfEditThenTestChecks(
  classifications: IfEditThenTestClassification[],
  events: TranscriptEvent[]
): CheckResult[] {
  const editedPaths = extractEditedPaths(events);
  const testPaths = editedPaths.filter((p) => TEST_FILE_PATTERN.test(p));
  const prodPaths = editedPaths.filter((p) => !TEST_FILE_PATTERN.test(p));

  return classifications.map(({ rule }) => {
    if (prodPaths.length === 0) {
      return {
        ruleId: rule.id,
        ruleTitle: rule.title,
        ruleSource: rule.source,
        status: "UNCLEAR",
        evidence:
          editedPaths.length === 0
            ? "no Write/Edit/NotebookEdit tool calls with a file_path in this session — can't tell if the rule applied"
            : "no non-test file was edited this session — the rule never had a chance to apply",
      };
    }

    if (testPaths.length === 0) {
      return {
        ruleId: rule.id,
        ruleTitle: rule.title,
        ruleSource: rule.source,
        status: "FAIL",
        evidence: `edited ${prodPaths.slice(0, 3).join(", ")}${prodPaths.length > 3 ? ", ..." : ""} but no matching test file was touched`,
      };
    }

    return {
      ruleId: rule.id,
      ruleTitle: rule.title,
      ruleSource: rule.source,
      status: "PASS",
      evidence: `edited ${prodPaths[0]} and also touched a test file: ${testPaths[0]}`,
    };
  });
}
