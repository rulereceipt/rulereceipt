import type { TranscriptEvent, CheckResult } from "../types.js";
import { violation } from "../types.js";
import { isProjectPath } from "./projectPaths.js";
import type { FileLifecycleClassification } from "./classify.js";
import { segments, leadingCommand, withoutCommitMessage } from "./shellCommand.js";

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

/**
 * The command moves into a throwaway tree before doing anything. Anything
 * it mutates after that is a scratch file, not the project's.
 */
const CD_INTO_TEMP = /\bcd\s+["']?(?:\/private)?\/(?:tmp|var\/folders)\b|\bcd\s+["']?[^\s"'&|;]*\/(?:scratchpad|node_modules)\b/;

/**
 * A path named only inside a heredoc body was not touched by the command
 * that contains it.
 *
 * Real case, 2026-09-15: a command editing landing/index.html through a
 * Python heredoc was reported as modifying `.claude/`, because the HTML it
 * inserts tells readers to put a hook in `.claude/settings.json`. Writing a
 * path into a file is not mutating that path.
 */
function mutatesPathInBash(rawCommand: string, filePath: string): boolean {
  const p = pathPattern(filePath);
  const bare = escapeRegex(filePath.replace(/^\.\//, ""));
  // A truncation/append redirect onto the path, with a trailing path boundary
  // so `> CHANGELOG.md.new` does NOT count as touching `CHANGELOG.md` (#9).
  const redirect = new RegExp(`>>?\\s*['"]?${bare}(?=$|[\\s'";)])`);
  // sed only mutates with an in-place flag; matched as a real flag, not a bare
  // "-i" substring that can sit inside a replacement like `s/api-id/…/` (#10).
  const sedInPlace = /(?:^|\s)sed\b[^|;&]*\s(?:--in-place\b|-[A-Za-z]*i\b)/;

  // Reason per SEGMENT: the mutating verb must be the segment's own leading
  // command, so a path named inside a commit message, an echoed string, or
  // another command's argument is not read as a mutation (#2). Heredoc bodies
  // are already stripped by `segments`.
  for (const raw of segments(rawCommand)) {
    const seg = withoutCommitMessage(raw);
    if (redirect.test(seg)) return true;
    const exe = leadingCommand(seg);
    if ((exe === "rm" || exe === "rmdir" || exe === "unlink") && new RegExp(`\\b(?:rm|rmdir|unlink)\\b[^|;&]*${p}`).test(seg)) return true;
    if ((exe === "mv" || exe === "cp") && new RegExp(`\\b(?:mv|cp)\\b[^|;&]*${p}\\s*$`).test(seg)) return true;
    if (exe === "tee" && new RegExp(`\\btee\\b[^|;&]*${p}`).test(seg)) return true;
    if (exe === "truncate" && new RegExp(`\\btruncate\\b[^|;&]*${p}`).test(seg)) return true;
    if (exe === "sed" && sedInPlace.test(seg) && new RegExp(p).test(seg)) return true;
  }
  return false;
}

interface MutationResult {
  /** The mutation that counts (the file was edited inside the project). */
  mutation: string | null;
  /**
   * The forbidden file WAS edited, but at a throwaway path outside the project
   * (a /tmp or /var scratch dir), so it is not counted as a violation. Recorded
   * separately so the report can say that honestly ("edited outside the project,
   * not checked") instead of the misleading "never written to".
   */
  outsideProject: string | null;
}

function findMutation(events: TranscriptEvent[], filePath: string): MutationResult {
  const normalized = filePath.replace(/^\.\//, "");
  let outsideProject: string | null = null;
  for (const event of events) {
    if (event.kind !== "tool_use") continue;

    if (WRITE_LIKE_TOOLS.has(event.toolName)) {
      const input = event.input as { file_path?: unknown };
      if (typeof input?.file_path === "string") {
        const actual = input.file_path.replace(/^\.\//, "");
        const matches = actual === normalized || actual.endsWith(`/${normalized}`);
        if (!matches) continue;
        // A throwaway copy is not the project's file. A rule saying
        // "CHANGELOG.md is release-only" fired on a scratchpad CHANGELOG.md
        // written during a probe and deleted minutes later — the basename
        // matched and nothing else was checked. But say so, rather than claim
        // the file was never touched: it WAS, just somewhere we don't govern.
        if (!isProjectPath(actual)) {
          if (!outsideProject) outsideProject = input.file_path;
          continue;
        }
        return { mutation: `${event.toolName} on ${input.file_path}`, outsideProject };
      }
      continue;
    }

    if (event.toolName === "Bash") {
      const input = event.input as { command?: unknown };
      if (typeof input?.command === "string" && mutatesPathInBash(input.command, filePath)) {
        // A command whose working directory is a temp tree is operating on
        // throwaway files, however the paths inside it are spelled.
        //
        // The first version required the temp prefix to sit next to the
        // filename, which cannot work: the real command that exposed this
        // does `cd /tmp` on its first line and writes `.claude/CLAUDE.md`
        // three lines later. A shortened one-line fixture passed while the
        // real command kept failing.
        if (CD_INTO_TEMP.test(input.command)) {
          if (!outsideProject) outsideProject = input.command;
          continue;
        }
        return { mutation: input.command, outsideProject };
      }
    }
  }
  return { mutation: null, outsideProject };
}

export function runFileLifecycleChecks(
  classifications: FileLifecycleClassification[],
  events: TranscriptEvent[]
): CheckResult[] {
  return classifications.map(({ rule, filePath, polarity, polarityInferred }) => {
    const { mutation, outsideProject } = findMutation(events, filePath);

    if (polarity === "forbid") {
      if (mutation) {
        return violation(rule, polarity, `"${filePath}" was actually modified: ${mutation.slice(0, 160)}`, { method: "file_events", polarityInferred });
      }
      // The forbidden file WAS edited, but at a throwaway path outside the
      // project (a /tmp or /var scratch dir). Never a FAIL — but do NOT claim it
      // was never written: it was, somewhere we don't govern. Can't-tell, said
      // honestly, so the user can judge whether that path actually mattered.
      if (outsideProject) {
        return {
          ruleId: rule.id,
          ruleTitle: rule.title,
          ruleSource: rule.source,
          status: "UNCLEAR" as const,
          outcome: "not_applicable" as const,
          method: "file_events" as const,
          ceiling: "the edit was to a path outside the project folder, which the project's rules do not govern",
          evidence: `"${filePath}" was edited at ${outsideProject.slice(0, 160)}, outside the project folder (a /tmp or scratch path), so it was not checked`,
        };
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
        method: "file_events" as const,
        ceiling: "a check of file-mutation events — it shows no mutation of this path was recorded, not that the file is untouched on disk",
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
