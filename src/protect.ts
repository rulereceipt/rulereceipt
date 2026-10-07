import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

/**
 * `rulereceipt protect` — the one-command "fix it" that pairs with history
 * mode's "here's what broke". It wires RuleReceipt's enforcement into Claude
 * Code: a PreToolUse guard (refuses a command that breaks a file/branch rule,
 * and asks before an unapproved push/commit) and a Stop hook (won't let a
 * session end on a broken rule or an unbacked "done").
 *
 * RuleReceipt's whole stance is that a tool must not silently write to your
 * settings, so this is the ONE place it writes — and only after showing exactly
 * what it will add and asking. `protect --undo` restores the settings file
 * byte-for-byte (or removes it, if there was none before). Writes are atomic
 * (temp file + rename) so a crash mid-write can never leave a half-file.
 */

const GUARD_CMD = "rulereceipt guard";
const HOOK_CMD = "rulereceipt hook";

export type ProtectScope = "user" | "project";

/**
 * Where protect writes its hooks. Default is USER level (~/.claude/settings.json),
 * not the project's .claude/settings.json — because the agent being guarded is
 * working INSIDE the project and can edit a project-level settings file to turn
 * its own guard off (raised on HN, 2026-10-07). A user-level hook sits outside
 * the repo the agent edits, and applies your rules to every project (it is a
 * no-op where a project has no rules). For true tamper-resistance, enterprise
 * managed-settings.json is the only real answer — see KNOWN-GAPS.
 */
function settingsPathFor(cwd: string, scope: ProtectScope): string {
  return scope === "project"
    ? join(cwd, ".claude", "settings.json")
    : join(homedir(), ".claude", "settings.json");
}
function backupPathFor(cwd: string, scope: ProtectScope): string {
  // User-level backup lives under the home dir so `protect --undo` finds it from
  // any directory; project-level stays next to the project it guards.
  return scope === "project"
    ? join(cwd, ".rulereceipt", "protect-backup.json")
    : join(homedir(), ".rulereceipt", "protect-backup.json");
}

interface HookEntry {
  hooks?: { type?: string; command?: string }[];
}
interface Settings {
  hooks?: Record<string, HookEntry[]>;
  [k: string]: unknown;
}

function hasRuleReceiptHook(settings: Settings, event: string, cmdSubstring: string): boolean {
  const arr = settings.hooks?.[event];
  if (!Array.isArray(arr)) return false;
  return arr.some((entry) => Array.isArray(entry.hooks) && entry.hooks.some((h) => typeof h.command === "string" && h.command.includes(cmdSubstring)));
}

function addHook(settings: Settings, event: string, command: string): void {
  settings.hooks = settings.hooks ?? {};
  const arr = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
  arr.push({ hooks: [{ type: "command", command }] });
  settings.hooks[event] = arr;
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.rr-tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

export interface ProtectPlan {
  /** Where the hooks are written: "user" (~/.claude) by default, or "project". */
  scope: ProtectScope;
  settingsPath: string;
  existed: boolean;
  /** The exact original bytes, or null if the settings file did not exist. */
  original: string | null;
  /** The settings content protect would write. */
  next: string;
  /** Human labels of what will be added. */
  toAdd: string[];
  /** True when both hooks are already present — nothing to do. */
  alreadyProtected: boolean;
  /**
   * True when the settings file exists but is not parseable JSON (a comment, a
   * trailing comma, or genuinely broken). protect MUST NOT rewrite it — doing so
   * would delete the user's own settings (deny rules, model, other hooks). The
   * caller shows the hooks to add by hand and changes nothing. Found by a real
   * test, 2026-09-29: a JSONC file lost its `permissions.deny` rule.
   */
  parseError: boolean;
}

/** The two hook lines to add by hand, for the parse-error path. */
export const PROTECT_HOOK_SNIPPET = `"hooks": {
  "PreToolUse": [{ "hooks": [{ "type": "command", "command": "${GUARD_CMD}" }] }],
  "Stop": [{ "hooks": [{ "type": "command", "command": "${HOOK_CMD}" }] }]
}`;

export function planProtect(cwd: string, scope: ProtectScope = "user"): ProtectPlan {
  const settingsPath = settingsPathFor(cwd, scope);
  const existed = existsSync(settingsPath);
  let original: string | null = null;
  let settings: Settings = {};
  if (existed) {
    original = readFileSync(settingsPath, "utf-8");
    try {
      const parsed = JSON.parse(original) as unknown;
      if (parsed && typeof parsed === "object") settings = parsed as Settings;
    } catch {
      // Malformed/JSONC (comment, trailing comma, or broken): REFUSE. Rewriting
      // it would silently delete the user's own settings — deny rules, model,
      // other hooks. Return a plan that changes NOTHING and flags the parse
      // error so the caller can tell the user and show the lines to add by hand.
      return { scope, settingsPath, existed, original, next: original, toAdd: [], alreadyProtected: false, parseError: true };
    }
  }

  const toAdd: string[] = [];
  if (!hasRuleReceiptHook(settings, "PreToolUse", GUARD_CMD)) {
    addHook(settings, "PreToolUse", GUARD_CMD);
    toAdd.push("PreToolUse guard — refuses a command that breaks a file/branch rule, and asks before an unapproved push/commit");
  }
  if (!hasRuleReceiptHook(settings, "Stop", HOOK_CMD)) {
    addHook(settings, "Stop", HOOK_CMD);
    toAdd.push("Stop hook — won't let a session end on a broken rule or a 'done' with no evidence");
  }

  return {
    scope,
    settingsPath,
    existed,
    original,
    next: `${JSON.stringify(settings, null, 2)}\n`,
    toAdd,
    alreadyProtected: toAdd.length === 0,
    parseError: false,
  };
}

export function applyProtect(cwd: string, plan: ProtectPlan): void {
  // Never write over a file we could not parse — that is the data-loss bug this
  // guards against. The CLI stops before here, but this makes it impossible.
  if (plan.parseError) throw new Error("refusing to write: the settings file is not valid JSON");
  // Record exactly what to restore (the original bytes, or that there was no
  // file) BEFORE touching anything, so --undo is byte-for-byte.
  atomicWrite(backupPathFor(cwd, plan.scope), `${JSON.stringify({ settingsPath: plan.settingsPath, existed: plan.existed, original: plan.original }, null, 2)}\n`);
  atomicWrite(plan.settingsPath, plan.next);
}

export interface UndoResult {
  ok: boolean;
  message: string;
}

export function undoProtect(cwd: string): UndoResult {
  // Check the user-level backup (~/.rulereceipt) and the project-level one, so
  // undo works whichever scope protect used.
  // Project backup first (specific to this repo), then the user-level one.
  const backupPath = [backupPathFor(cwd, "project"), backupPathFor(cwd, "user")].find((p) => existsSync(p));
  if (!backupPath) {
    return { ok: false, message: "Nothing to undo — no `protect` backup found in ~/.rulereceipt/ or ./.rulereceipt/." };
  }
  let backup: { settingsPath: string; existed: boolean; original: string | null };
  try {
    backup = JSON.parse(readFileSync(backupPath, "utf-8"));
  } catch {
    return { ok: false, message: "The protect backup is unreadable, so undo was not attempted (your settings were left as they are)." };
  }
  if (backup.existed && typeof backup.original === "string") {
    atomicWrite(backup.settingsPath, backup.original);
  } else if (existsSync(backup.settingsPath)) {
    rmSync(backup.settingsPath);
  }
  rmSync(backupPath);
  return { ok: true, message: `Restored ${backup.settingsPath} to its state before protect. Start a new Claude Code session for it to take effect.` };
}
