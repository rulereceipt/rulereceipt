/**
 * Validates the clause-splitting mixed-polarity logic at corpus scale.
 * Two questions the single reported case cannot answer:
 *  1. Do single-clause prohibitions ("Never run `x`") still get a literal
 *     check, or did clause-splitting push them all to judgment?
 *  2. Does splitting on . ; \n and " - " misfire on periods inside code
 *     spans, version numbers, or "e.g."/"i.e."?
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseClaudeMd } from "../src/parsers/claudeMdParser.js";
import { classifyRule } from "../src/checks/classify.js";

const DIR = process.argv[2] ?? "corpus";
function walk(d: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(d)) {
    const f = join(d, e);
    try { statSync(f).isDirectory() ? out.push(...walk(f)) : out.push(f); } catch { /* skip */ }
  }
  return out;
}

// A single-clause prohibition naming a literal: the canonical shape that
// must stay a literal check.
const SINGLE_CLAUSE_PROHIBITION = /^[^.;\n]*\b(never|don't|do not|avoid)\b[^.;\n]*`[^`]+`[^.;\n]*$/i;
const RISKY_SPLIT = /(e\.g\.|i\.e\.|\bv?\d+\.\d+|`[^`]*\.[^`]*`)/i;

let singleClause = 0, singleClauseToJudgment = 0;
let risky = 0, riskyToJudgment = 0;
const judgmentExamples: string[] = [];
const riskyExamples: string[] = [];

for (const path of walk(DIR)) {
  let rules;
  try { rules = parseClaudeMd(path, "project"); } catch { continue; }
  for (const r of rules) {
    const text = `${r.title} ${r.text}`;
    const kind = classifyRule(r).kind;
    if (SINGLE_CLAUSE_PROHIBITION.test(r.text) || SINGLE_CLAUSE_PROHIBITION.test(r.title)) {
      singleClause++;
      if (kind === "judgment") {
        singleClauseToJudgment++;
        if (judgmentExamples.length < 6) judgmentExamples.push(text.slice(0, 78));
      }
    }
    if (RISKY_SPLIT.test(text) && /\b(never|don't|do not)\b/i.test(text)) {
      risky++;
      if (kind === "judgment") {
        riskyToJudgment++;
        if (riskyExamples.length < 6) riskyExamples.push(text.slice(0, 78));
      }
    }
  }
}

console.log(`\n[1] Single-clause prohibitions naming a literal ("Never run \`x\`"):`);
console.log(`    found: ${singleClause}`);
console.log(`    wrongly sent to judgment: ${singleClauseToJudgment} (${singleClause ? ((singleClauseToJudgment/singleClause)*100).toFixed(1) : 0}%)`);
judgmentExamples.forEach((e) => console.log(`      - ${e}`));

console.log(`\n[2] Prohibitions containing split-risky text (e.g./i.e./versions/dotted code spans):`);
console.log(`    found: ${risky}`);
console.log(`    sent to judgment: ${riskyToJudgment} (${risky ? ((riskyToJudgment/risky)*100).toFixed(1) : 0}%)`);
riskyExamples.forEach((e) => console.log(`      - ${e}`));
console.log();
