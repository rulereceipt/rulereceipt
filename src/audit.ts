import { classifyRules } from "./checks/classify.js";
import { adviseRules } from "./checkability.js";
import type { Rule } from "./types.js";

/**
 * A rules-only health score — how much of a rules file can actually be checked,
 * with NO session needed.
 *
 * The recurring day-one gap: a first `check` with no session is empty, and a
 * real CLAUDE.md is mostly a handbook — measured across the public corpus, ~38%
 * of items are rules and ~56% of those need judgment. `audit` answers "is your
 * rules file enforceable?" on any format (CLAUDE.md, AGENTS.md, Cursor, Copilot,
 * Windsurf, Gemini) instantly, and points at `rules --advise` for the fixes.
 *
 * Buckets, by how classifyRule routes each item:
 *  - checkable : any structured/deterministic kind — a session can be checked
 *                against it without a human or an LLM
 *  - judgment  : needs a person (or `--llm`)
 *  - skipped   : not a rule (docs, directory maps, glossary rows)
 */
export interface RulesAudit {
  total: number;
  checkable: number;
  judgment: number;
  skipped: number;
  /** checkable / (checkable + judgment), whole %, 0 when there are no rules. */
  percentCheckable: number;
  /** The highest-leverage rewrites — a concrete rule missing only its literal. */
  topFixes: { title: string; suggestion: string }[];
}

export function auditRules(rules: Rule[]): RulesAudit {
  let checkable = 0;
  let judgment = 0;
  let skipped = 0;
  for (const c of classifyRules(rules)) {
    if (c.kind === "notARule") skipped++;
    else if (c.kind === "judgment") judgment++;
    else checkable++;
  }
  const decided = checkable + judgment;
  const topFixes = adviseRules(rules)
    .filter((a) => a.actionable)
    .slice(0, 5)
    .map((a) => ({ title: a.ruleTitle, suggestion: a.suggestion }));
  return {
    total: checkable + judgment + skipped,
    checkable,
    judgment,
    skipped,
    percentCheckable: decided > 0 ? Math.round((checkable / decided) * 100) : 0,
    topFixes,
  };
}

/** A short, readable audit. Never says "compliant" — it measures the file, not a session. */
export function renderAudit(a: RulesAudit, md = false): string {
  if (a.checkable + a.judgment === 0) {
    return md
      ? "**No rules found** in this project's rules files. Is there a `CLAUDE.md`, `AGENTS.md` or similar here?"
      : "No rules found in this project's rules files.\nIs there a CLAUDE.md / AGENTS.md (or Cursor/Copilot/Windsurf rules) here?";
  }
  const H = (s: string) => (md ? `## ${s}` : s);
  const out: string[] = [];
  out.push(md ? "# RuleReceipt — rules audit" : "RuleReceipt · rules audit  (no session needed)");
  out.push("");
  out.push(`${a.checkable + a.judgment} rules read (plus ${a.skipped} documentation item${a.skipped === 1 ? "" : "s"} not scored).`);
  out.push("");
  out.push(H("Can this session be checked against them?"));
  out.push(`  ${String(a.checkable).padStart(4)}  checkable        — verifiable from a session, no human needed`);
  out.push(`  ${String(a.judgment).padStart(4)}  need judgment    — a person (or \`--llm\`) decides these`);
  out.push(`  ${String(a.skipped).padStart(4)}  documentation    — structure/notes, not scored as rules`);
  out.push("");
  out.push(`${a.percentCheckable}% of your rules can be checked mechanically.`);
  out.push("");
  if (a.topFixes.length > 0) {
    out.push(H("Top fixes to unlock more checks"));
    for (const f of a.topFixes) {
      out.push(`  • ${f.title.replace(/\s+/g, " ").trim().slice(0, 60)}`);
      out.push(`      ${f.suggestion}`);
    }
    out.push("");
  }
  out.push("Full advice, rule by rule:  rulereceipt rules --advise");
  return out.join("\n");
}
