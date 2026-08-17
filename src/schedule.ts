import { execSync } from "node:child_process";

export type Cadence = "weekly" | "monthly";

const MARKER = "# rulereceipt-digest";

const CRON_EXPR: Record<Cadence, string> = {
  weekly: "0 9 * * 1", // 9am every Monday
  monthly: "0 9 1 * *", // 9am on the 1st of each month
};

function readCurrentCrontab(): string {
  try {
    return execSync("crontab -l", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
  } catch {
    // `crontab -l` exits non-zero when no crontab exists yet — that's a
    // normal empty state, not a real error.
    return "";
  }
}

function writeCrontab(content: string): void {
  execSync("crontab -", { input: content, encoding: "utf-8" });
}

/**
 * Explicit opt-in only, per the project's standing rule against
 * anything running automatically without the user asking — this
 * function only ever runs when the user types `rulereceipt digest
 * --enable`, never on its own. Only ever touches the single line it
 * tagged with MARKER; every other crontab entry is left untouched.
 */
export function enableSchedule(cadence: Cadence): void {
  const current = readCurrentCrontab();
  const withoutOurLine = current
    .split("\n")
    .filter((line) => !line.includes(MARKER))
    .join("\n")
    .trimEnd();

  const cmd = `/bin/bash -l -c 'npx --yes rulereceipt digest --email' ${MARKER}`;
  const newLine = `${CRON_EXPR[cadence]} ${cmd}`;

  const updated = (withoutOurLine ? withoutOurLine + "\n" : "") + newLine + "\n";
  writeCrontab(updated);
}

export function disableSchedule(): void {
  const current = readCurrentCrontab();
  const withoutOurLine = current
    .split("\n")
    .filter((line) => !line.includes(MARKER))
    .join("\n");
  writeCrontab(withoutOurLine.trimEnd() + (withoutOurLine.trim() ? "\n" : ""));
}

export function scheduleStatus(): Cadence | null {
  const current = readCurrentCrontab();
  const line = current.split("\n").find((l) => l.includes(MARKER));
  if (!line) return null;
  if (line.startsWith(CRON_EXPR.weekly)) return "weekly";
  if (line.startsWith(CRON_EXPR.monthly)) return "monthly";
  return null;
}
