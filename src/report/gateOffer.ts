import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Is a RuleReceipt hook already wired into this project or this machine?
 *
 * Read-only, and deliberately forgiving: an unreadable or malformed settings
 * file means "assume not installed" rather than an error. A missing settings
 * file is the normal case, not a problem.
 */
export function hookIsInstalled(cwd: string): boolean {
  const candidates = [
    join(cwd, ".claude", "settings.json"),
    join(cwd, ".claude", "settings.local.json"),
    join(homedir(), ".claude", "settings.json"),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      // Matched as text rather than by walking the hook schema: the shape of
      // that config has changed before, and a rename of one field should not
      // make this start nagging someone who already installed it.
      if (/rulereceipt\s+(hook|guard)/.test(readFileSync(path, "utf-8"))) return true;
    } catch {
      // unreadable settings file — treat as not installed
    }
  }
  return false;
}

/**
 * The line offering enforcement, or null when it should not be shown.
 *
 * The site describes the Stop hook to someone deciding whether to adopt the
 * tool at all. This speaks to someone who has already run it and is looking
 * at rules that were broken — which is the moment the offer is a consequence
 * of what they just read rather than an advertisement.
 *
 * Three conditions, and each is a way of not nagging:
 *
 *   - Only when something actually failed. On a clean report there is
 *     nothing to enforce and the line would be a pitch.
 *   - Never when the hook is already installed. Telling someone to do what
 *     they have already done is how a tool gets muted.
 *   - One line, no config block. A terminal report is not documentation, and
 *     pasting JSON into it would bury the findings it sits under.
 */
export function gateOffer(state: { failures: number; hookInstalled: boolean }): string | null {
  if (state.failures === 0) return null;
  if (state.hookInstalled) return null;
  const n = state.failures;
  return (
    `This report is after the fact. \`rulereceipt hook\` runs as a Claude Code Stop hook and\n` +
    `refuses to let a session end on ${n === 1 ? "a broken rule" : "a broken rule"} — see the README for the four lines to add.`
  );
}
