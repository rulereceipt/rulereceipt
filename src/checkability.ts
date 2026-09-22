import type { Rule } from "./types.js";
import { classifyRule } from "./checks/classify.js";

/**
 * Why a rule can't be checked mechanically, and what to change so it can.
 *
 * The other half of hookCoverage. `hookCoverage` answers "which rules have a
 * hook behind them"; this answers "which rules can't be checked at all, and
 * how to fix that." Both come from the same complaint — a CLAUDE.md full of
 * rules that read fine to a human and mean nothing to a checker
 * (anthropics/claude-code#2544, and the whole "wish list, not a contract"
 * genre).
 *
 * It never rewrites the rule. It says, in one line, what is missing and the
 * smallest edit that would make the rule land in a real check — usually
 * naming the concrete command, file or branch the rule is about, in
 * backticks. Some rules are genuine judgment calls ("surface bad news
 * first") and the honest advice is that no edit makes them mechanical; those
 * are for the LLM judge, and this says so rather than pretending otherwise.
 */

export interface RuleAdvice {
  ruleTitle: string;
  /** The classifier's verdict: "judgment" or "notARule". */
  kind: "judgment" | "notARule";
  /** One line: what is missing and the smallest edit that fixes it. */
  suggestion: string;
}

/** A concrete action the rule is plausibly about, so we can name what to quote. */
const CONCRETE_SUBJECT =
  /\b(?:push(?:es|ed|ing)?|commit(?:s|ted|ting)?|merge[ds]?|rebase|delet\w*|remov\w*|\brm\b|drop|truncate|deploy\w*|migrat\w*|branch|tag|force[- ]?push|test|lint|build|install|env|secret|token|password|key|\.env|database|table|file|path|directory|endpoint|api)\b/i;

/** A rule that is qualitative by nature — no literal makes it mechanical. */
const QUALITATIVE =
  /\b(?:concise|verbose|clear|clean|readable|tone|polite|honest|thorough|surface\s+bad\s+news|be\s+kind|professional|idiomatic|maintainable|simple|elegant|good\s+judg\w*|reasonable|appropriate|well[- ]?(?:written|structured|named))\b/i;

function hasBacktickLiteral(rule: Rule): boolean {
  return /`[^`]{2,}`/.test(`${rule.title} ${rule.text}`);
}

/** A believable backtick example for the kind of subject the rule named. */
function exampleFor(subject: string): string {
  if (/push|commit|merge|rebase|branch|tag|force/.test(subject)) return "`git push`, `main`";
  if (/deploy|migrat/.test(subject)) return "`vercel --prod`, `npm run deploy`";
  if (/test|lint|build|install/.test(subject)) return "`npm test`, `npm run build`";
  if (/\.env|secret|token|password|key/.test(subject)) return "`.env`, `.env.production`";
  if (/database|table/.test(subject)) return "`data/app.db`, `DROP TABLE`";
  if (/file|path|directory|endpoint|api/.test(subject)) return "`data/x.db`, `src/config.ts`";
  if (/rm|delet|remov|drop|truncate/.test(subject)) return "`rm`, `data/x.db`";
  return "`git push`, `data/x.db`";
}

/**
 * Advice for one rule, or null when the rule is already mechanically checked.
 */
export function adviseRule(rule: Rule): RuleAdvice | null {
  const kind = classifyRule(rule).kind;
  if (kind !== "judgment" && kind !== "notARule") return null;

  const text = `${rule.title} ${rule.text}`;

  if (kind === "notARule") {
    return {
      ruleTitle: rule.title,
      kind,
      suggestion:
        "reads as documentation or an incident note, not a rule to check. If it IS a rule, phrase it as a direct imperative (\"Never …\", \"Always …\") so a check can bind to it.",
    };
  }

  // kind === "judgment"
  if (QUALITATIVE.test(text) && !CONCRETE_SUBJECT.test(text)) {
    return {
      ruleTitle: rule.title,
      kind,
      suggestion:
        "a genuine judgment call — no edit makes it mechanical. It can only be graded with the LLM judge (`check --llm`); that is expected, not a defect.",
    };
  }

  if (CONCRETE_SUBJECT.test(text) && !hasBacktickLiteral(rule)) {
    const m = text.match(CONCRETE_SUBJECT);
    const subject = m ? m[0].toLowerCase() : "the action";
    return {
      ruleTitle: rule.title,
      kind,
      suggestion:
        `mentions ${subject} but names no exact term to match. Put the concrete command, file or branch in backticks (e.g. ${exampleFor(subject)}) and it becomes a mechanical check.`,
    };
  }

  return {
    ruleTitle: rule.title,
    kind,
    suggestion:
      "has no concrete term a check can bind to. Name the exact command, file, branch or flag it is about in backticks, or leave it for the LLM judge (`check --llm`).",
  };
}

/** Advice for every rule that isn't already mechanically checked. */
export function adviseRules(rules: Rule[]): RuleAdvice[] {
  return rules.map(adviseRule).filter((a): a is RuleAdvice => a !== null);
}
