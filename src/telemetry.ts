import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const TELEMETRY_ENDPOINT = "https://rulereceipt.dev/api/telemetry";

function telemetryIdPath(): string {
  return join(homedir(), ".rulereceipt", "telemetry-id");
}

/**
 * One random, non-identifying ID per machine — not tied to an email, name,
 * or IP beyond what any HTTP request already exposes. Created once, reused
 * on every future run, so the server can count distinct installs instead of
 * just counting events (which `--share`'s pass/fail counts already do).
 * Deliberately a bare UUID on its own line, no JSON wrapper — this file has
 * exactly one job.
 */
function getOrCreateTelemetryId(): string {
  const path = telemetryIdPath();
  try {
    const existing = readFileSync(path, "utf-8").trim();
    if (existing.length > 0) return existing;
  } catch {
    // doesn't exist yet, fall through to create it
  }
  const id = randomUUID();
  try {
    const dir = join(homedir(), ".rulereceipt");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, id, "utf-8");
    chmodSync(path, 0o600);
  } catch {
    // best-effort — if it can't be persisted, still use this id for the
    // current run rather than skipping the ping entirely
  }
  return id;
}

/**
 * Opt-in only, same convention as --share: off unless this run explicitly
 * asks for it. Real gap found after shipping this default-on for a few
 * hours (2026-08-30): a per-run ping is exactly the kind of unannounced
 * network call this tool's own `doctor` command exists to flag in OTHER
 * projects' configs, and the audience for a Claude Code auditing tool is
 * unusually likely to actually check with mitmproxy/strace. Reversed
 * before any real install base existed — DO_NOT_TRACK/RULERECEIPT_NO_TELEMETRY
 * still work as a hard override even if --telemetry is passed, so opting in
 * once can still be overridden per-environment (e.g. a shared CI runner).
 */
export function isTelemetryEnabled(telemetryFlag: boolean): boolean {
  if (process.env.DO_NOT_TRACK === "1" || process.env.DO_NOT_TRACK === "true") return false;
  if (process.env.RULERECEIPT_NO_TELEMETRY === "1" || process.env.RULERECEIPT_NO_TELEMETRY === "true") return false;
  return telemetryFlag;
}

/**
 * Sends only the anonymous install ID — never rule text, file paths,
 * session content, or even pass/fail counts (that's what opt-in --share is
 * for). A send failure must never affect the `check` command's own exit
 * code or output; this is best-effort and silent on failure.
 */
export async function sendTelemetryPing(): Promise<void> {
  const id = getOrCreateTelemetryId();
  try {
    await fetch(TELEMETRY_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // best-effort, non-fatal
  }
}
