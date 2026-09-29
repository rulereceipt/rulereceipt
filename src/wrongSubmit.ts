import { spawnSync, type SpawnSyncReturns } from "node:child_process";

/**
 * The two ways to send a wrong-verdict report, kept as pure, testable pieces so
 * the command wiring in cli.ts stays thin. Nothing here sends on its own: it
 * builds the exact `gh issue create` argv and the exact mailto: URL, and the
 * caller only runs them AFTER an explicit yes (see cli.ts). `--yes` never skips
 * that preview+confirm — the report is public, so the default answer is No.
 */

export const SUPPORT_EMAIL = "hello@rulereceipt.dev";
export const REPO = "rulereceipt/rulereceipt";
export const ISSUE_LABEL = "wrong-verdict";

type Runner = (cmd: string, args: string[]) => SpawnSyncReturns<Buffer>;
const defaultRun: Runner = (cmd, args) => spawnSync(cmd, args, { stdio: "ignore" });

/** True only if `gh` is installed AND logged in. No issue is offered otherwise. */
export function ghReady(run: Runner = defaultRun): boolean {
  try {
    if (run("gh", ["--version"]).status !== 0) return false;
    return run("gh", ["auth", "status"]).status === 0;
  } catch {
    return false;
  }
}

export function issueTitle(reported: string, ruleTitle: string): string {
  const t = ruleTitle.replace(/\s+/g, " ").trim().slice(0, 60);
  return `Wrong verdict: ${reported} on ${t}`;
}

/** argv for `gh issue create`. The label is included only when withLabel. */
export function issueCreateArgs(title: string, body: string, withLabel: boolean): string[] {
  const args = ["issue", "create", "--repo", REPO, "--title", title, "--body", body];
  if (withLabel) args.push("--label", ISSUE_LABEL);
  return args;
}

// A conservative cap so the mailto: fits what mail clients accept; a longer body
// is trimmed and the user is told to attach the saved .md file instead.
export const MAILTO_MAX = 1800;

export function mailtoSubject(ruleTitle: string): string {
  return `RuleReceipt wrong verdict: ${ruleTitle.replace(/\s+/g, " ").trim().slice(0, 80)}`;
}

export function buildMailto(subject: string, body: string): { url: string; trimmed: boolean } {
  let b = body;
  let trimmed = false;
  if (b.length > MAILTO_MAX) {
    b = b.slice(0, MAILTO_MAX) + "\n\n[Report trimmed to fit email — attach the saved .md file instead.]";
    trimmed = true;
  }
  const url = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(b)}`;
  return { url, trimmed };
}
