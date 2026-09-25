import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckResult, CheckMethod, Rule } from "./types.js";
import { ruleFingerprint } from "./overrides.js";

/**
 * A committed, team-shared config at .rulereceipt/config.json.
 *
 * ONE place for "how hard should this rule bite", a ladder per rule handle:
 *
 *   off    hidden from the report, never gates CI
 *   warn   shown, does not fail the build
 *   error  shown, FAILS the build (the default for a checkable rule)
 *
 * This is the honest version of "severity": a team marks must-not-break rules
 * as errors (the default) and nice-to-haves as warnings, and silences the
 * irrelevant ones, so CI gates on what actually matters instead of going red
 * on day one. It replaces three scattered mechanisms — the old `warn` list,
 * `rules --exclude` (now `off`), and the plain default — with one field.
 *
 * Pre-run BLOCKING is deliberately NOT a mode here: refusing a command before
 * it runs still goes through the guard's clause-mark (`rules --forbid`),
 * because a config that could block on any rule would refuse the 62.8% of
 * commands the measured guard already showed it must not. This file governs
 * the report and the CI gate; the guard governs refusal.
 *
 * Handles, not rule ids: an id is positional and renumbers when the file is
 * edited above it; a handle is a content hash, so it survives edits. Get one
 * from `rulereceipt rules --list`.
 *
 * Backward compatible: the old top-level `warn: [handle, ...]` list still
 * works and means the same as `rules: { <handle>: "warn" }`.
 */
export type RuleMode = "off" | "warn" | "error";

const VALID_MODES: readonly string[] = ["off", "warn", "error"];

export interface ProjectConfig {
  warn: string[];
  rules: Record<string, RuleMode>;
  /** A whole check type, by friendly name (see CHECK_ALIASES) or raw method. */
  checks: Record<string, RuleMode>;
}

/**
 * Friendly names for a check type, so `checks: { "emoji": "off" }` silences
 * every emoji verdict without listing each rule. A result carries a `method`
 * (e.g. "emoji_output"); these are the human-facing aliases for those.
 */
export const CHECK_ALIASES: Record<string, CheckMethod> = {
  emoji: "emoji_output",
  attribution: "attribution_scan",
  approval: "approval_gate",
  git: "git_events",
  files: "file_events",
  code: "code_content",
  claim: "claim_vs_evidence",
  tests: "edit_test_pairing",
  text: "text_scan",
  judgment: "model_judgment",
};

export const PROJECT_CONFIG_PATH = join(".rulereceipt", "config.json");

export function loadProjectConfig(cwd: string): ProjectConfig {
  try {
    const parsed = JSON.parse(readFileSync(join(cwd, PROJECT_CONFIG_PATH), "utf-8")) as {
      warn?: unknown;
      rules?: unknown;
      checks?: unknown;
    };
    const warn = Array.isArray(parsed?.warn) ? parsed.warn.filter((x): x is string => typeof x === "string") : [];
    const readModes = (raw: unknown): Record<string, RuleMode> => {
      const out: Record<string, RuleMode> = {};
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        for (const [key, mode] of Object.entries(raw as Record<string, unknown>)) {
          if (typeof mode === "string" && VALID_MODES.includes(mode)) out[key] = mode as RuleMode;
        }
      }
      return out;
    };
    return { warn, rules: readModes(parsed?.rules), checks: readModes(parsed?.checks) };
  } catch {
    // Missing or malformed config means no severities configured, never an
    // error — same fail-open discipline as the rest of the tool.
    return { warn: [], rules: {}, checks: {} };
  }
}

/** The mode a `checks` entry sets for a result's method, if any. */
function checkMode(method: CheckMethod | undefined, config: ProjectConfig): RuleMode | undefined {
  if (!method || !config.checks || Object.keys(config.checks).length === 0) return undefined;
  // A raw method key ("emoji_output") wins over its friendly alias ("emoji").
  if (config.checks[method]) return config.checks[method];
  for (const [alias, m] of Object.entries(CHECK_ALIASES)) {
    if (m === method && config.checks[alias]) return config.checks[alias];
  }
  return undefined;
}

/**
 * The mode for one result. Precedence: a per-rule `rules` entry wins over a
 * per-check `checks` entry, which wins over the legacy `warn` list; anything
 * unlisted is `error`, so the default is unchanged and no config means today's
 * behaviour exactly.
 */
export function modeForResult(
  result: CheckResult,
  config: ProjectConfig,
  handleFor: (r: CheckResult) => string
): RuleMode {
  const handle = handleFor(result);
  if (config.rules[handle]) return config.rules[handle];
  const byCheck = checkMode(result.method, config);
  if (byCheck) return byCheck;
  if (config.warn.includes(handle)) return "warn";
  return "error";
}

/** Results the report should show — everything except rules set to `off`. */
export function visibleResults(
  results: CheckResult[],
  config: ProjectConfig,
  handleFor: (r: CheckResult) => string
): CheckResult[] {
  return results.filter((r) => modeForResult(r, config, handleFor) !== "off");
}

/** A lookup from a result back to its stable rule handle, built from the loaded rules. */
export function handleMap(rules: Rule[]): (r: CheckResult) => string {
  const m = new Map<string, string>();
  for (const rule of rules) m.set(`${rule.source}:${rule.id}`, ruleFingerprint(rule));
  return (r) => m.get(`${r.ruleSource}:${r.ruleId}`) ?? "";
}

/** FAILs at `error` mode — these fail the build. (`off` never reaches here.) */
export function blockingFailures(
  results: CheckResult[],
  config: ProjectConfig,
  handleFor: (r: CheckResult) => string
): CheckResult[] {
  return results.filter((r) => r.status === "FAIL" && modeForResult(r, config, handleFor) === "error");
}

/** FAILs at `warn` mode — shown, but they do not fail the build. */
export function warningFailures(
  results: CheckResult[],
  config: ProjectConfig,
  handleFor: (r: CheckResult) => string
): CheckResult[] {
  return results.filter((r) => r.status === "FAIL" && modeForResult(r, config, handleFor) === "warn");
}
