import { parseClaudeMdText } from "../parsers/claudeMdParser.js";
import { classifyRules } from "../checks/classify.js";

/**
 * Entry point for the in-browser checker on the site.
 *
 * The privacy claim on that page — "your file never leaves this page" — is
 * only true because everything reachable from here is pure string work.
 * parseClaudeMdText and classifyRules touch no Node API, no network, and
 * no storage. If anything in this dependency chain ever gains an import
 * that does, the page's claim becomes false and must change with it.
 *
 * Deliberately returns counts and a small sample, never the file: nothing
 * here should make it easy to accidentally send the text somewhere.
 */

export interface Breakdown {
  kind: string;
  count: number;
}

export interface AnalysisResult {
  /** Everything the parser pulled out of the file, rules and non-rules alike. */
  parsed: number;
  /** Items carrying no instruction — documentation, tables, listings. */
  notRules: number;
  /** Items that are genuinely directives. */
  realRules: number;
  /** Real rules a check can answer by looking at what ran. */
  checkable: number;
  /** Real rules that need a person. */
  judgment: number;
  /** Share of the whole file that isn't an instruction, 0-100. */
  notRulesPct: number;
  /** Share of REAL rules that are mechanically answerable, 0-100. */
  checkablePct: number;
  byKind: Breakdown[];
  /** A few non-rule titles, so the number is inspectable rather than asserted. */
  notRuleSamples: string[];
  /** A few judgment-call titles, same reason. */
  judgmentSamples: string[];
}

/** Measured across 559 real public rules files. Shown for comparison. */
export const CORPUS = {
  files: 559,
  parsed: 21986,
  notRulesPct: 63.4,
  checkablePct: 44.2,
};

function pct(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 1000) / 10;
}

export function analyze(text: string): AnalysisResult {
  const rules = parseClaudeMdText(text, "project");
  const classified = classifyRules(rules);

  const counts = new Map<string, number>();
  const notRuleSamples: string[] = [];
  const judgmentSamples: string[] = [];

  for (const c of classified) {
    counts.set(c.kind, (counts.get(c.kind) ?? 0) + 1);
    const title = c.rule.title.trim();
    if (!title) continue;
    if (c.kind === "notARule" && notRuleSamples.length < 4) notRuleSamples.push(title);
    if (c.kind === "judgment" && judgmentSamples.length < 4) judgmentSamples.push(title);
  }

  const parsed = classified.length;
  const notRules = counts.get("notARule") ?? 0;
  const judgment = counts.get("judgment") ?? 0;
  const realRules = parsed - notRules;
  const checkable = realRules - judgment;

  const byKind = [...counts.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count);

  return {
    parsed,
    notRules,
    realRules,
    checkable,
    judgment,
    notRulesPct: pct(notRules, parsed),
    checkablePct: pct(checkable, realRules),
    byKind,
    notRuleSamples,
    judgmentSamples,
  };
}
