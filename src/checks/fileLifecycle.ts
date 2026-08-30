import type { TranscriptEvent, CheckResult } from "../types.js";
import type { FileLifecycleClassification } from "./classify.js";

/**
 * Third structured-check primitive: only counts real MUTATIONS of a
 * protected file, never reads of it. Real false-positive this fixes
 * (found 2026-08-30 on a real session): a rule protecting
 * `.claude/settings.json` reported it as touched because the agent ran
 * `cat .claude/settings.json` to VERIFY its contents — reading a
 * protected file to confirm it's intact is the opposite of violating the
 * rule, and flagging it punishes exactly the behavior the rule wants.
 *
 * Counts as a mutation:
 *  - Write / Edit / NotebookEdit tool_use whose file_path is the file
 *  - A Bash command using a destructive/overwriting operator on the path
 *    (rm, mv onto it, truncation via `>`, sed -i, tee)
 *
 * Explicitly NOT a mutation: cat, less, head, tail, grep, Read, ls, or
 * the path merely appearing in prose or in another command's arguments.
 *
 * Known, stated limitation: Bash detection is regex over the command
 * string, not a shell parser. A sufficiently exotic invocation (an
 * unusual redirect form, a path built from a variable, a mutation inside
 * a script file that is itself invoked) will be missed — that's a false
 * NEGATIVE (reports PASS/UNCLEAR), the safe direction. This must never
 * fabricate a FAIL from a command that only read the file.
 */
const WRITE_LIKE_TOOLS = new Set(["Write", "Edit", "NotebookEdit"]);

function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A path is "the same file" if the command references it exactly, or
 * references a path ending in it (so a rule naming
 * `.claude/settings.json` still matches an absolute
 * `/home/x/.claude/settings.json`). Deliberately anchored at a path
 * boundary so `settings.json` does not match `other-settings.json`.
 */
function pathPattern(filePath: string): string {
  return `(?:^|[\\s'"=/])${escapeRegex(filePath.replace(/^\.\//, ""))}(?=$|[\\s'";)])`;
}

function mutatesPathInBash(command: string, filePath: string): boolean {
  const p = pathPattern(filePath);
  const mutations = [
    // rm / rmdir / unlink targeting the path
    new RegExp(`\\b(?:rm|rmdir|unlink)\\b[^|;&]*${p}`),
    // mv / cp writing ONTO the path (path appears as the final argument)
    new RegExp(`\\b(?:mv|cp)\\b[^|;&]*${p}\\s*(?:$|[;&|])`),
    // truncation or append redirect onto the path
    new RegExp(`>>?\\s*['"]?${escapeRegex(filePath.replace(/^\.\//, ""))}`),
    // in-place edits
    new RegExp(`\\bsed\\b[^|;&]*-i[^|;&]*${p}`),
    new RegExp(`\\btee\\b[^|;&]*${p}`),
    new RegExp(`\\btruncate\\b[^|;&]*${p}`),
  ];
  return mutations.some((re) => re.test(command));
}

function findMutation(events: TranscriptEvent[], filePath: string): string | null {
  const normalized = filePath.replace(/^\.\//, "");
  for (const event of events) {
    if (event.kind !== "tool_use") continue;

    if (WRITE_LIKE_TOOLS.has(event.toolName)) {
      const input = event.input as { file_path?: unknown };
      if (typeof input?.file_path === "string") {
        const actual = input.file_path.replace(/^\.\//, "");
        if (actual === normalized || actual.endsWith(`/${normalized}`)) {
          return `${event.toolName} on ${input.file_path}`;
        }
      }
      continue;
    }

    if (event.toolName === "Bash") {
      const input = event.input as { command?: unknown };
      if (typeof input?.command === "string" && mutatesPathInBash(input.command, filePath)) {
        return input.command;
      }
    }
  }
  return null;
}

export function runFileLifecycleChecks(
  classifications: FileLifecycleClassification[],
  events: TranscriptEvent[]
): CheckResult[] {
  return classifications.map(({ rule, filePath, polarity }) => {
    const mutation = findMutation(events, filePath);

    if (polarity === "forbid") {
      if (mutation) {
        return {
          ruleId: rule.id,
          ruleTitle: rule.title,
          ruleSource: rule.source,
          status: "FAIL",
          evidence: `"${filePath}" was actually modified: ${mutation.slice(0, 160)}`,
        };
      }
      return {
        ruleId: rule.id,
        ruleTitle: rule.title,
        ruleSource: rule.source,
        status: "PASS",
        evidence: `"${filePath}" was never written to, deleted, or moved this session (reading it does not count)`,
      };
    }

    // require: absence is UNCLEAR, not a fabricated FAIL — same reasoning
    // as deterministicChecks.ts's require-polarity handling
    if (mutation) {
      return {
        ruleId: rule.id,
        ruleTitle: rule.title,
        ruleSource: rule.source,
        status: "PASS",
        evidence: `"${filePath}" was updated as required: ${mutation.slice(0, 160)}`,
      };
    }
    return {
      ruleId: rule.id,
      ruleTitle: rule.title,
      ruleSource: rule.source,
      status: "UNCLEAR",
      evidence: `"${filePath}" was never modified this session — can't tell if the rule didn't apply, or applied and was skipped`,
    };
  });
}
