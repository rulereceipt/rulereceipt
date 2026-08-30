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
 * Respects the cross-tool DO_NOT_TRACK convention (Next.js, Vite, etc. all
 * honor this) in addition to a project-specific env var and a per-run CLI
 * flag — three independent ways to opt out, deliberately more than one.
 */
export function isTelemetryDisabled(noTelemetryFlag: boolean): boolean {
  if (noTelemetryFlag) return true;
  if (process.env.DO_NOT_TRACK === "1" || process.env.DO_NOT_TRACK === "true") return true;
  if (process.env.RULERECEIPT_NO_TELEMETRY === "1" || process.env.RULERECEIPT_NO_TELEMETRY === "true") return true;
  return false;
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
