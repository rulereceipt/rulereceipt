import type { Rule } from "../types.js";

export type DeterministicPolarity = "forbid" | "require";

export interface DeterministicClassification {
  kind: "deterministic";
  rule: Rule;
  /** Literal strings pulled from the rule text (backtick-quoted) that a
   * violation would contain — e.g. a banned CLI flag, or a required one. */
  patterns: string[];
  /** "forbid": pattern found anywhere -> FAIL (the only mode that existed
   * before). "require": pattern must appear somewhere -> its ABSENCE is
   * what fails, e.g. "always run `npm test` before committing." */
  polarity: DeterministicPolarity;
}

export interface JudgmentClassification {
  kind: "judgment";
  rule: Rule;
}

export type Classification = DeterministicClassification | JudgmentClassification;

const BACKTICK_TOKEN = /`([^`]+)`/g;

// Keyword signal near the rule text that this is a mandatory action, not a
// ban. Deliberately conservative: only a short, explicit set of words a
// real rule author actually uses for "you must do this" phrasing. Anything
// ambiguous defaults to "forbid" semantics (pattern found = FAIL), which
// was the only behavior that existed before this — no regression risk,
// only an additive one for rules that clearly ask for a required action.
const REQUIRE_SIGNAL = /\b(always|must|required|require|ensure|need to)\b/i;
const FORBID_SIGNAL = /\b(never|don't|do not|forbidden|banned|must not)\b/i;

function detectPolarity(rule: Rule): DeterministicPolarity {
  const text = `${rule.title} ${rule.text}`;
  // An explicit forbid word anywhere wins over a require word — "you must
  // never use X" contains both "must" and "never", and it's a ban.
  if (FORBID_SIGNAL.test(text)) return "forbid";
  if (REQUIRE_SIGNAL.test(text)) return "require";
  return "forbid";
}

/**
 * A rule is only treated as deterministic when it names a specific,
 * literal, checkable token (a CLI flag, a command, an exact string) in
 * backticks — e.g. "never use `git push --force`". Everything else
 * defaults to judgment, per the spec: never silently skip a rule by
 * guessing it's safe to pattern-match.
 */
export function classifyRule(rule: Rule): Classification {
  const patterns = new Set<string>();
  for (const match of rule.text.matchAll(BACKTICK_TOKEN)) {
    const token = match[1].trim();
    if (token.length > 0) patterns.add(token);
  }
  for (const match of rule.title.matchAll(BACKTICK_TOKEN)) {
    const token = match[1].trim();
    if (token.length > 0) patterns.add(token);
  }

  if (patterns.size === 0) {
    return { kind: "judgment", rule };
  }
  return { kind: "deterministic", rule, patterns: [...patterns], polarity: detectPolarity(rule) };
}

export function classifyRules(rules: Rule[]): Classification[] {
  return rules.map(classifyRule);
}
