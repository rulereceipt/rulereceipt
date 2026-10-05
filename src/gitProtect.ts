import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, rmSync, statSync, chmodSync } from "node:fs";
import { join, dirname, isAbsolute, resolve } from "node:path";
import { guardDecision } from "./guard.js";

/**
 * `rulereceipt protect --git` — the git-time counterpart to the Claude Code
 * guard. It installs a `pre-push` hook that runs `rulereceipt git-guard`, which
 * refuses a push that breaks a branch rule (e.g. "never push to main directly")
 * — catching a push made OUTSIDE Claude Code, by hand or by another tool, that
 * the PreToolUse guard never sees. The native escape hatch is unchanged:
 * `git push --no-verify` bypasses it, because a human overriding their own rule
 * at the terminal is their call.
 *
 * Same stance as `protect`: it writes exactly one file, shows it first, backs it
 * up, and `--git --undo` restores byte-for-byte. It never clobbers a pre-push
 * hook it didn't write — if a foreign one exists, it refuses and prints the one
 * line to add by hand.
 */

const GUARD_LINE = "rulereceipt git-guard";
const MARKER = "RuleReceipt pre-push guard";

export const PRE_PUSH_SCRIPT = `#!/bin/sh
# ${MARKER} — blocks a push that breaks a branch rule.
# Remove with:  rulereceipt protect --git --undo   (or just delete this file)
# Override a single push with:  git push --no-verify
if command -v rulereceipt >/dev/null 2>&1; then
  ${GUARD_LINE} || exit 1
else
  echo "RuleReceipt not installed — git guard inactive. Install: npm i -g rulereceipt" >&2
fi
exit 0
`;

/** Resolve the hooks directory, following a `.git` file (worktree/submodule) when present. */
export function gitHooksDir(cwd: string): string | null {
  const dotGit = join(cwd, ".git");
  if (!existsSync(dotGit)) return null;
  let gitDir = dotGit;
  try {
    if (statSync(dotGit).isFile()) {
      const m = readFileSync(dotGit, "utf-8").match(/gitdir:\s*(.+)\s*/);
      if (!m) return null;
      gitDir = isAbsolute(m[1]) ? m[1] : resolve(cwd, m[1]);
    }
  } catch {
    return null;
  }
  return join(gitDir, "hooks");
}

function backupPathFor(cwd: string): string {
  return join(cwd, ".rulereceipt", "git-protect-backup.json");
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.rr-tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

export interface GitProtectPlan {
  hookPath: string | null;
  existed: boolean;
  /** Original bytes of an existing pre-push, or null if none. */
  original: string | null;
  /** Already installed by us — nothing to do. */
  alreadyProtected: boolean;
  /** A pre-push hook exists that is NOT ours — refuse rather than clobber. */
  foreignHook: boolean;
  /** No .git here at all. */
  notAGitRepo: boolean;
}

export function planGitProtect(cwd: string): GitProtectPlan {
  const hooksDir = gitHooksDir(cwd);
  if (!hooksDir) return { hookPath: null, existed: false, original: null, alreadyProtected: false, foreignHook: false, notAGitRepo: true };
  const hookPath = join(hooksDir, "pre-push");
  const existed = existsSync(hookPath);
  let original: string | null = null;
  if (existed) {
    original = readFileSync(hookPath, "utf-8");
    if (original.includes(MARKER) || original.includes(GUARD_LINE)) {
      return { hookPath, existed, original, alreadyProtected: true, foreignHook: false, notAGitRepo: false };
    }
    return { hookPath, existed, original, alreadyProtected: false, foreignHook: true, notAGitRepo: false };
  }
  return { hookPath, existed, original: null, alreadyProtected: false, foreignHook: false, notAGitRepo: false };
}

export function applyGitProtect(cwd: string, plan: GitProtectPlan): void {
  if (plan.foreignHook) throw new Error("refusing to overwrite an existing pre-push hook that RuleReceipt did not write");
  if (!plan.hookPath) throw new Error("not a git repository");
  atomicWrite(backupPathFor(cwd), `${JSON.stringify({ hookPath: plan.hookPath, existed: plan.existed, original: plan.original }, null, 2)}\n`);
  atomicWrite(plan.hookPath, PRE_PUSH_SCRIPT);
  chmodSync(plan.hookPath, 0o755);
}

export interface UndoResult {
  ok: boolean;
  message: string;
}

export function undoGitProtect(cwd: string): UndoResult {
  const backupPath = backupPathFor(cwd);
  if (!existsSync(backupPath)) return { ok: false, message: "Nothing to undo — no `protect --git` backup found in .rulereceipt/." };
  let backup: { hookPath: string; existed: boolean; original: string | null };
  try {
    backup = JSON.parse(readFileSync(backupPath, "utf-8"));
  } catch {
    return { ok: false, message: "The git-protect backup is unreadable, so undo was not attempted (your hook was left as it is)." };
  }
  if (backup.existed && typeof backup.original === "string") atomicWrite(backup.hookPath, backup.original);
  else if (existsSync(backup.hookPath)) rmSync(backup.hookPath);
  rmSync(backupPath);
  return { ok: true, message: `Removed the RuleReceipt pre-push hook from ${backup.hookPath}.` };
}

/**
 * The branches a pre-push invocation is pushing, parsed from the hook's stdin.
 * Each line is `<local ref> <local oid> <remote ref> <remote oid>`; a delete
 * (local oid all zeros) is skipped — deleting a branch is not a push to it.
 */
export function branchesFromPrePushStdin(stdin: string): string[] {
  const out: string[] = [];
  for (const line of stdin.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const [, localOid, remoteRef] = parts;
    if (/^0+$/.test(localOid)) continue; // deletion
    const m = remoteRef.match(/^refs\/heads\/(.+)$/);
    if (m) out.push(m[1]);
  }
  return out;
}

export interface GitGuardResult {
  block: boolean;
  messages: string[];
}

/**
 * Evaluate a pending push (pre-push stdin) against the branch rules, reusing the
 * SAME guardDecision as the Claude Code hook — so the two can never disagree. A
 * branch the guard would DENY or ASK on blocks the push; the message names the
 * rule and points at `git push --no-verify` for a deliberate override. With no
 * refs to push, or no rules, it does not block.
 */
export function evaluateGitPush(cwd: string, stdin: string): GitGuardResult {
  const messages: string[] = [];
  let block = false;
  for (const branch of branchesFromPrePushStdin(stdin)) {
    const command = `git push origin ${branch}`;
    const d = guardDecision(cwd, "Bash", { command }, []);
    if (d.deny) {
      block = true;
      messages.push(`Blocked: push to "${branch}" — ${(d.reason || "a branch rule forbids it").replace(/\s+/g, " ").trim()}`);
    } else if (d.ask) {
      block = true;
      messages.push(`Blocked: push to "${branch}" needs approval — ${(d.ask || "a rule asks you to confirm first").replace(/\s+/g, " ").trim()}`);
    }
  }
  if (block) messages.push("If this push is intentional, override it with:  git push --no-verify");
  return { block, messages };
}
