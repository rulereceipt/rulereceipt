import type { Rule } from "../types.js";

export interface DeterministicClassification {
  kind: "deterministic";
  rule: Rule;
  /** Literal strings pulled from the rule text (backtick-quoted) that a
   * violation would contain — e.g. a banned CLI flag. */
  patterns: string[];
}

export interface JudgmentClassification {
  kind: "judgment";
  rule: Rule;
}

export type Classification = DeterministicClassification | JudgmentClassification;

const BACKTICK_TOKEN = /`([^`]+)`/g;

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
  return { kind: "deterministic", rule, patterns: [...patterns] };
}

export function classifyRules(rules: Rule[]): Classification[] {
  return rules.map(classifyRule);
}
