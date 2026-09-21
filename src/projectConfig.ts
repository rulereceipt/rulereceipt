import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckResult, Rule } from "./types.js";
import { ruleFingerprint } from "./overrides.js";

/**
 * A committed, team-shared config at .rulereceipt/config.json.
 *
 * Today it holds one thing: rule handles to treat as WARNINGS — a broken
 * "warning" rule is still reported, but it does not fail the build. This is
 * the honest version of "severity": a team marks the must-not-break rules as
 * errors (the default) and the nice-to-have ones as warnings, so CI gates on
 * what actually matters instead of going red on day one.
 *
 * Handles, not rule ids: an id is positional and renumbers when the file is
 * edited above it; a handle is a content hash, so it survives edits. Get one
 * from `rulereceipt rules --list`.
 */
export interface ProjectConfig {
  warn: string[];
}

export const PROJECT_CONFIG_PATH = join(".rulereceipt", "config.json");

export function loadProjectConfig(cwd: string): ProjectConfig {
  try {
    const parsed = JSON.parse(readFileSync(join(cwd, PROJECT_CONFIG_PATH), "utf-8")) as { warn?: unknown };
    const warn = parsed?.warn;
    return { warn: Array.isArray(warn) ? warn.filter((x): x is string => typeof x === "string") : [] };
  } catch {
    // Missing or malformed config means no severities configured, never an
    // error — same fail-open discipline as the rest of the tool.
    return { warn: [] };
  }
}

/** A lookup from a result back to its stable rule handle, built from the loaded rules. */
export function handleMap(rules: Rule[]): (r: CheckResult) => string {
  const m = new Map<string, string>();
  for (const rule of rules) m.set(`${rule.source}:${rule.id}`, ruleFingerprint(rule));
  return (r) => m.get(`${r.ruleSource}:${r.ruleId}`) ?? "";
}

/** FAILs that are NOT configured as warnings — these fail the build. */
export function blockingFailures(
  results: CheckResult[],
  config: ProjectConfig,
  handleFor: (r: CheckResult) => string
): CheckResult[] {
  return results.filter((r) => r.status === "FAIL" && !config.warn.includes(handleFor(r)));
}

/** FAILs that ARE configured as warnings — shown, but they do not fail the build. */
export function warningFailures(
  results: CheckResult[],
  config: ProjectConfig,
  handleFor: (r: CheckResult) => string
): CheckResult[] {
  return results.filter((r) => r.status === "FAIL" && config.warn.includes(handleFor(r)));
}
