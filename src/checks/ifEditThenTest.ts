import type { TranscriptEvent, CheckResult } from "../types.js";
import type { IfEditThenTestClassification } from "./classify.js";
import { findTestRun } from "./testCommands.js";

const TEST_FILE_PATTERN = /(\.test\.|\.spec\.|__tests__\/|_test\.|\/tests?\/)/i;

// Real false-positive found 2026-08-30 on an actual session: editing a
// markdown documentation file flagged "no test file touched" four
// separate times — but a doc/config file was never going to have a test
// companion under any reasonable reading of an "add tests for every
// change" rule. Excluded from prodPaths entirely, same as test files.
const NON_TESTABLE_FILE_PATTERN = /\.(md|mdx|txt|rst|json|ya?ml|toml|lock|csv|log)$/i;

/**
 * Paths that are not this project's source, whatever their extension.
 *
 * Found 2026-09-12 running 559 real rules files against 5 real sessions: 24
 * FAILs said "edited /private/tmp/.../scratchpad/probe.mjs but no matching
 * test file was touched". That is a throwaway probe, written to inspect
 * something and deleted minutes later. Demanding a test for it is nonsense;
 * demanding one as a FAIL is a false accusation.
 *
 * Only file extensions were excluded before, so any temp file that happened
 * to end in .ts or .mjs counted as production code.
 */
const NON_PROJECT_PATH_PATTERN =
  /(?:^|\/)(?:tmp|temp|scratch|scratchpad|node_modules|dist|build|out|coverage|\.git|\.next|\.cache|vendor|__pycache__)(?:\/|$)|^\/(?:private\/)?(?:tmp|var)\//i;

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
  // Running the suite honours "add tests for every change" as much as
  // touching a test file does. Without this, the most ordinary workflow
  // there is — change code, run the tests, commit — produced a FAIL saying
  // no test file was touched. Twelve rules across the 559-file corpus hit
  // it on one synthetic session (2026-09-11).
  //
  // Any run in the session counts, not only one after the edit. Requiring
  // the stricter ordering would buy a little precision and risk the
  // expensive direction of error, and in this project a wrong FAIL costs
  // more than a missed detection.
  const testRun = findTestRun(events);
  const testPaths = editedPaths.filter((p) => TEST_FILE_PATTERN.test(p));
  const prodPaths = editedPaths.filter(
    (p) =>
      !TEST_FILE_PATTERN.test(p) &&
      !NON_TESTABLE_FILE_PATTERN.test(p) &&
      !NON_PROJECT_PATH_PATTERN.test(p)
  );

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
            : "no code file was edited this session (only test/doc/config files, if any) — the rule never had a chance to apply",
      };
    }

    if (testPaths.length === 0 && testRun !== null) {
      return {
        ruleId: rule.id,
        ruleTitle: rule.title,
        ruleSource: rule.source,
        status: "PASS" as const,
        evidence: `edited ${prodPaths[0]} and ran the suite: \`${testRun}\` (no test file was edited, but the code was exercised)`,
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
