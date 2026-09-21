import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { compareVersions } from "./whatsNew.js";

/**
 * The online complement to the offline "what's new" footer: tell someone on
 * an old global install that a newer version exists.
 *
 * OPT-IN, never by default. RuleReceipt's whole promise is that it makes no
 * network call you did not ask for — telemetry is opt-in for the same reason,
 * and an auditing tool that quietly phones a registry is the hypocrisy it
 * exists to catch. Enabled only by --check-updates or RULERECEIPT_CHECK_UPDATES=1,
 * cached so it pings at most once a day, and fails open on any error.
 */

const REGISTRY = "https://registry.npmjs.org/rulereceipt/latest";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

function stampPath(): string {
  return join(homedir(), ".rulereceipt", "last-update-check");
}

export function isUpdateCheckEnabled(flag: boolean): boolean {
  if (flag) return true;
  const env = process.env.RULERECEIPT_CHECK_UPDATES;
  return env === "1" || env === "true";
}

/** True if enough time has passed since the last check (or there was none). */
export function shouldCheckNow(now: number, lastCheck: number | null, intervalMs = CHECK_INTERVAL_MS): boolean {
  if (lastCheck === null) return true;
  return now - lastCheck >= intervalMs;
}

function readLastCheck(): number | null {
  try {
    const n = parseInt(readFileSync(stampPath(), "utf-8").trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function writeLastCheck(now: number): void {
  try {
    const dir = join(homedir(), ".rulereceipt");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(stampPath(), String(now), "utf-8");
  } catch {
    // best-effort
  }
}

/** The nudge, or null if the current version is already latest (or newer). */
export function renderUpdateNudge(current: string, latest: string): string | null {
  if (compareVersions(latest, current) <= 0) return null;
  return `\nA newer rulereceipt is available: v${latest} (you have v${current}). Update with: npx rulereceipt@latest`;
}

async function fetchLatestVersion(): Promise<string | null> {
  try {
    const res = await fetch(REGISTRY, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === "string" ? body.version : null;
  } catch {
    return null;
  }
}

/**
 * Orchestration: only when enabled, only when due, fetch the latest version
 * and nudge if newer. Records the check time even on failure so a flaky
 * network does not turn into a ping on every single run.
 */
export async function maybeCheckUpdates(current: string, enabled: boolean, log: (s: string) => void = console.log): Promise<void> {
  try {
    if (!enabled) return;
    if (!shouldCheckNow(Date.now(), readLastCheck())) return;
    writeLastCheck(Date.now());
    const latest = await fetchLatestVersion();
    if (!latest) return;
    const nudge = renderUpdateNudge(current, latest);
    if (nudge) log(nudge);
  } catch {
    // never let an update check affect the run
  }
}
