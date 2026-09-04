import type { Rule } from "../types.js";
import type { HookEntry } from "./doctor.js";

/**
 * Which of your rules has anything behind it?
 *
 * Two people arrived at this question independently within a week. From a
 * dev.to thread: "does the parser separate a rule that's only a sentence from
 * the same rule with a hook behind it? In a file they look identical, and
 * only the hooked one fails loudly when it's ignored." And from
 * anthropics/claude-code#90542, someone with a hook-heavy setup reporting
 * 13 out of 13 held where enforcement existed, and 1 failure out of 1
 * opportunity where the same decision was written as prose.
 *
 * The tool could already list hooks (`doctor`) and list rules (`check`).
 * Nothing joined them, so it could tell you what your hooks were and what
 * your rules were, and not which rules were load-bearing.
 *
 * WHAT THIS CANNOT DO, STATED UP FRONT
 *
 * It cannot prove a hook enforces a rule. A hook's command is usually a path
 * to a script this tool does not read, so the only machine-readable evidence
 * available is the event it fires on, the matcher it is registered under, and
 * whatever literal text sits in the command string.
 *
 * That means both errors are possible and neither is rare:
 *   - a hook can enforce a rule while sharing no text with it at all
 *   - sharing text proves nothing about whether the hook actually guards it
 *
 * So this reports a POSSIBLE backing and nothing stronger. It is a starting
 * point for a person who knows their own setup, in the same spirit as
 * `--show-skipped`: surface what the tool can see, and let the judgement sit
 * with whoever can actually make it.
 */

export type Backing = "possiblyGuarded" | "noHookFound";

export interface RuleCoverage {
  rule: Rule;
  backing: Backing;
  /** Hooks sharing a literal token with this rule. Empty when noHookFound. */
  matchedHooks: HookEntry[];
  /** The tokens that matched, so the user can see WHY it was linked. */
  sharedTokens: string[];
}

/**
 * Events that can actually refuse something. A hook on an event that cannot
 * block may still be useful — logging, injecting context — but it cannot make
 * a rule fail loudly, which is the question being asked here.
 *
 * Taken from the documented hook reference. PostToolUse is deliberately
 * absent: it runs after the call has already succeeded.
 */
const BLOCKING_EVENTS = new Set([
  "PreToolUse",
  "UserPromptSubmit",
  "UserPromptExpansion",
  "Stop",
  "SubagentStop",
  "PostToolBatch",
  "TeammateIdle",
  "TaskCreated",
  "TaskCompleted",
  "ConfigChange",
  "WorktreeCreate",
  "PreModelSwitch",
]);

export function isBlockingEvent(event: string): boolean {
  return BLOCKING_EVENTS.has(event);
}

/**
 * Distinctive literals a rule names: backtick-quoted spans, and bare tokens
 * that look like a command, path or flag.
 *
 * Short and common tokens are dropped. Linking a rule to a hook because both
 * contain "the" or "test" would produce confident-looking nonsense, which is
 * worse than reporting nothing — the same reason a text match in this tool
 * can never produce a confident failure.
 */
const MIN_TOKEN_LENGTH = 4;
const TOO_COMMON = new Set([
  "test", "tests", "file", "files", "code", "main", "true", "false", "null",
  "type", "types", "name", "path", "line", "lines", "data", "when", "then",
  "with", "this", "that", "from", "into", "must", "should", "never", "always",
  "bash", "node", "json", "yaml", "text", "user", "call", "tool", "hook",
]);

export function distinctiveTokens(text: string): string[] {
  const found = new Set<string>();
  for (const [, span] of text.matchAll(/`([^`]{2,80})`/g)) {
    const cleaned = span.trim().toLowerCase();
    if (cleaned.length >= MIN_TOKEN_LENGTH && !TOO_COMMON.has(cleaned)) found.add(cleaned);
  }
  // Bare tokens shaped like a command, path or flag.
  for (const [, tok] of text.matchAll(/(?:^|\s)(--?[a-z][\w-]{2,}|[\w.-]*\/[\w./*-]+|[\w-]+\.[a-z]{2,4})\b/gi)) {
    const cleaned = tok.trim().toLowerCase();
    if (cleaned.length >= MIN_TOKEN_LENGTH && !TOO_COMMON.has(cleaned)) found.add(cleaned);
  }
  return [...found];
}

/**
 * Links rules to hooks by shared literal text.
 *
 * Only hooks on blocking events are considered: a rule "backed" by a hook
 * that cannot refuse anything is not backed in the sense being asked about.
 */
export function correlate(rules: Rule[], hooks: HookEntry[]): RuleCoverage[] {
  const blocking = hooks.filter((h) => isBlockingEvent(h.event));
  const hookText = blocking.map((h) => ({
    hook: h,
    haystack: `${h.command} ${h.matcher ?? ""}`.toLowerCase(),
  }));

  return rules.map((rule) => {
    const tokens = distinctiveTokens(`${rule.title} ${rule.text ?? ""}`);
    const matchedHooks: HookEntry[] = [];
    const sharedTokens = new Set<string>();
    for (const { hook, haystack } of hookText) {
      const hits = tokens.filter((t) => haystack.includes(t));
      if (hits.length > 0) {
        matchedHooks.push(hook);
        hits.forEach((h) => sharedTokens.add(h));
      }
    }
    return {
      rule,
      backing: matchedHooks.length > 0 ? "possiblyGuarded" : "noHookFound",
      matchedHooks,
      sharedTokens: [...sharedTokens],
    };
  });
}

export interface CoverageSummary {
  totalRules: number;
  possiblyGuarded: number;
  noHookFound: number;
  blockingHooks: number;
  nonBlockingHooks: number;
}

export function summarise(coverage: RuleCoverage[], hooks: HookEntry[]): CoverageSummary {
  return {
    totalRules: coverage.length,
    possiblyGuarded: coverage.filter((c) => c.backing === "possiblyGuarded").length,
    noHookFound: coverage.filter((c) => c.backing === "noHookFound").length,
    blockingHooks: hooks.filter((h) => isBlockingEvent(h.event)).length,
    nonBlockingHooks: hooks.filter((h) => !isBlockingEvent(h.event)).length,
  };
}
