import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseClaudeMd } from "../src/parsers/claudeMdParser.js";
import { classifyRule } from "../src/checks/classify.js";

const DIRECTIVE = /\b(never|always|must|should|do not|don't|dont|require[sd]?|ensure|avoid|prefer|forbidden|prohibited|only)\b/i;
let total = 0, directive = 0;
const nonDirDet: string[] = [];
for (const f of readdirSync("corpus").filter((f) => statSync(join("corpus", f)).isFile())) {
  for (const r of parseClaudeMd(join("corpus", f), "project")) {
    total++;
    if (DIRECTIVE.test(`${r.title} ${r.text}`)) directive++;
    else if (classifyRule(r).kind === "deterministic") nonDirDet.push(r.title.slice(0, 58));
  }
}
const nonDir = total - directive;
console.log(`total parsed as "rules": ${total}`);
console.log(`  has a directive word (never/always/must/...): ${directive} (${((directive / total) * 100).toFixed(1)}%)`);
console.log(`  NO directive word (likely documentation):     ${nonDir} (${((nonDir / total) * 100).toFixed(1)}%)`);
console.log(`\n${nonDirDet.length} non-directive items still get a keyword check run against them. Examples:`);
nonDirDet.slice(0, 8).forEach((t) => console.log("  - " + t));
