import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Per-project overrides: a way to say "this item in my rules file isn't
 * actually a rule for my project" without waiting for an upstream release.
 *
 * THE SECURITY PROPERTY THAT MAKES THIS SAFE
 *
 * An override never changes whether a check runs, and never changes its
 * result. The check executes exactly as it would have, keeps its real
 * status, and the override only changes how the result is PRESENTED.
 *
 * That distinction is the whole design. The obvious version of this
 * feature — "let the user mark a rule as not-a-rule, and skip it" — is
 * not safe, and restricting the direction of the override does not make
 * it safe:
 *
 *     Rule:  "Never commit directly to main"
 *     Agent: commits directly to main            -> FAIL
 *     User:  marks it "not a rule"               -> not checked
 *     Report: the violation is gone
 *
 * Nobody had to claim a pass. They deleted the question instead. So this
 * implementation refuses to delete questions. The worst an override can
 * do is draw a labelled box around a real violation and sign it with a
 * reason and a date — which leaves a reader BETTER informed than a plain
 * failure would, not worse.
 *
 * Consequences enforced elsewhere, and deliberately not weakened:
 *   - the exit code still fails on an overridden violation (cli.ts), or
 *     CI becomes the loophole this whole design exists to close;
 *   - the report's headline verdict counts overridden failures, or the
 *     one line everyone reads would be the one line that lies.
 *
 * A reason is mandatory. An override without one is refused, not applied
 * silently: it costs a sentence to write, and it is the part a reviewer
 * actually reads.
 *
 * AMBIGUOUS IDS FAIL CLOSED. A global CLAUDE.md and a project one can
 * legitimately both contain a "Rule 1" — the report already disambiguates
 * those on collision. An override written as `"rule": "1"` when two rules
 * share that id would silently disable BOTH, including one the user never
 * meant to touch. Found while testing this feature against a real machine
 * that has a global rules file. So a bare id is applied only when it is
 * unambiguous; when it is not, the override is refused and the user is
 * told to write `"project:1"` or `"global:1"` instead.
 */

export const OVERRIDES_FILE = ".rulereceipt.json";

export interface RuleOverride {
  /** Rule id as it appears in the report, e.g. "12" or "S7.0". */
  rule: string;
  /** Why this isn't a rule for this project. Required — never optional. */
  reason: string;
  /** Optional ISO date, shown in the report so a reader can judge staleness. */
  date?: string;
}

export interface LoadedOverrides {
  /** Keyed by the raw id as written by the user ("1" or "project:1"). */
  byRuleId: Map<string, RuleOverride>;
  /** Problems worth telling the user about — malformed entries, missing reasons. */
  problems: string[];
}

/** A rule as the report identifies it, used to resolve an override target. */
export interface OverrideTarget {
  ruleId: string;
  ruleSource: "global" | "project";
}

/**
 * Resolves override entries against the rules actually present, and
 * refuses anything ambiguous rather than guessing which rule was meant.
 * Returns a lookup keyed by `${source}:${id}`, plus any new problems.
 */
export function resolveOverrides(
  loaded: LoadedOverrides,
  targets: OverrideTarget[]
): { bySourceAndId: Map<string, RuleOverride>; problems: string[] } {
  const bySourceAndId = new Map<string, RuleOverride>();
  const problems = [...loaded.problems];

  for (const [written, entry] of loaded.byRuleId) {
    const scoped = /^(global|project):(.+)$/i.exec(written);
    if (scoped) {
      const source = scoped[1].toLowerCase() as "global" | "project";
      const id = scoped[2].trim();
      const hit = targets.find((t) => t.ruleId === id && t.ruleSource === source);
      if (!hit) {
        problems.push(`${OVERRIDES_FILE}: no ${source} rule with id "${id}" was found, so that override did nothing.`);
        continue;
      }
      bySourceAndId.set(`${source}:${id}`, entry);
      continue;
    }

    const matches = targets.filter((t) => t.ruleId === written);
    if (matches.length === 0) {
      problems.push(`${OVERRIDES_FILE}: no rule with id "${written}" was found, so that override did nothing.`);
      continue;
    }
    const sources = new Set(matches.map((m) => m.ruleSource));
    if (sources.size > 1) {
      problems.push(
        `${OVERRIDES_FILE}: rule id "${written}" exists in BOTH your global and project rules, so the override was NOT applied — it would have silently disabled both. Write "project:${written}" or "global:${written}" instead.`
      );
      continue;
    }
    bySourceAndId.set(`${[...sources][0]}:${written}`, entry);
  }

  return { bySourceAndId, problems };
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Reads and validates the override file. Never throws: a broken override
 * file must not take down a check that would otherwise have worked, and
 * an unreadable file means "no overrides", never "override everything".
 * Every rejection is reported rather than swallowed, so a user whose
 * override isn't working finds out why.
 */
export function loadOverrides(cwd: string): LoadedOverrides {
  const byRuleId = new Map<string, RuleOverride>();
  const problems: string[] = [];
  const path = join(cwd, OVERRIDES_FILE);
  if (!existsSync(path)) return { byRuleId, problems };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    problems.push(`${OVERRIDES_FILE} isn't valid JSON, so no overrides were applied: ${err instanceof Error ? err.message : String(err)}`);
    return { byRuleId, problems };
  }

  const raw = (parsed as { overrides?: unknown })?.overrides;
  if (raw === undefined) return { byRuleId, problems };
  if (!Array.isArray(raw)) {
    problems.push(`${OVERRIDES_FILE}: "overrides" must be an array, so no overrides were applied.`);
    return { byRuleId, problems };
  }

  for (const [i, entry] of raw.entries()) {
    const e = entry as Partial<RuleOverride>;
    if (!isNonEmptyString(e?.rule)) {
      problems.push(`${OVERRIDES_FILE} entry ${i + 1}: missing a "rule" id, so it was ignored.`);
      continue;
    }
    // Fails closed, on purpose. An override with no stated reason is the
    // exact shape of one added to make a number go away.
    if (!isNonEmptyString(e?.reason)) {
      problems.push(`${OVERRIDES_FILE} entry for rule ${e.rule}: no "reason" given, so it was NOT applied. Every override needs a reason a reviewer can read.`);
      continue;
    }
    byRuleId.set(e.rule.trim(), {
      rule: e.rule.trim(),
      reason: e.reason.trim(),
      date: isNonEmptyString(e.date) ? e.date.trim() : undefined,
    });
  }

  return { byRuleId, problems };
}
