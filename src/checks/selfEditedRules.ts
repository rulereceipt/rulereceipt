import type { TranscriptEvent } from "../types.js";
import { withoutHeredocs } from "./shellCommand.js";

/**
 * Did the session EDIT the rules or agent-settings it is being judged by?
 *
 * A verdict is about the rules as they are NOW. If the agent rewrote CLAUDE.md,
 * `.claude/settings.json` or `.rulereceipt/` during the session, the report
 * should say so out loud — "Claude changed CLAUDE.md this session, then passed
 * its own rules" is exactly what a reader needs to know. This is a NOTE, never a
 * FAIL: editing a rules file is not itself a violation, and plenty of legitimate
 * work does it (a session that adds a rule, `init`, a settings tweak). Added
 * 2026-09-28. Reading a rules file (Read / `cat` / `grep`) is not editing and
 * never warns — only a write whose target is a rules/settings file counts.
 */

/** A rules or agent-settings file, matched by path suffix. */
const RULE_FILE =
  /(?:^|[\\/])(?:CLAUDE(?:\.local)?\.md|AGENTS(?:\.local)?\.md|AGENT\.md|GEMINI\.md|\.cursorrules|\.windsurfrules|copilot-instructions\.md|settings(?:\.local)?\.json)$|(?:^|[\\/])\.claude[\\/]rules[\\/][^\\/]+$|(?:^|[\\/])\.cursor[\\/]rules[\\/][^\\/]+$|(?:^|[\\/])\.agents[\\/]rules[\\/][^\\/]+$|(?:^|[\\/])\.rulereceipt[\\/].+$/i;

function editTargetPath(input: unknown): string {
  const o = input as Record<string, unknown> | null;
  const p = o?.file_path ?? o?.notebook_path ?? o?.path;
  return typeof p === "string" ? p : "";
}

/**
 * Rules files a shell command WRITES to: a `>`/`>>`/`tee` target, a `sed -i`
 * file argument, or a `cp`/`mv`/`install` destination. A rules file that is only
 * read (`cat f`, `grep x f`, `sed -n p f`) is never a write target and does not
 * match — the same read-vs-write distinction the code checks already draw.
 */
function shellWriteTargets(command: string): string[] {
  const cmd = withoutHeredocs(command);
  const hits = new Set<string>();
  // redirect / tee target
  for (const m of cmd.matchAll(/(?:>>?|\btee\s+(?:-a\s+)?)\s*("?)([^\s"'|;&<>()]+)\1/g)) {
    if (RULE_FILE.test(m[2])) hits.add(m[2]);
  }
  // sed -i edits its file argument(s) in place
  if (/\bsed\s+-i/.test(cmd)) {
    for (const m of cmd.matchAll(/(\S+)/g)) if (RULE_FILE.test(m[1])) hits.add(m[1]);
  }
  // cp / mv / install: the destination is the last non-option argument
  for (const m of cmd.matchAll(/\b(?:cp|mv|install)\b([^|;&]*)/g)) {
    const args = m[1].trim().split(/\s+/).filter((a) => a && !a.startsWith("-"));
    const dest = args[args.length - 1];
    if (dest && RULE_FILE.test(dest)) hits.add(dest);
  }
  return [...hits];
}

/** Rules/settings files the session wrote to, deduped, in first-seen order. */
export function detectSelfEditedRuleFiles(events: TranscriptEvent[]): string[] {
  const found = new Set<string>();
  for (const e of events) {
    if (e.kind !== "tool_use") continue;
    if (e.toolName === "Write" || e.toolName === "Edit" || e.toolName === "MultiEdit" || e.toolName === "NotebookEdit") {
      const p = editTargetPath(e.input);
      if (p && RULE_FILE.test(p)) found.add(p);
    } else if (e.toolName === "Bash") {
      const c = (e.input as { command?: unknown } | null)?.command;
      if (typeof c === "string") for (const f of shellWriteTargets(c)) found.add(f);
    }
  }
  return [...found];
}
