import type { Rule } from "../types.js";

/**
 * Day 3: decide whether a rule can be checked deterministically (plain
 * pattern matching, zero API calls) or needs judgment (needs an LLM call).
 * Default to "judgment" when unsure — never silently skip a rule.
 */
export function classifyRule(_rule: Rule): "deterministic" | "judgment" {
  throw new Error("TODO: implement — start here Day 3");
}
