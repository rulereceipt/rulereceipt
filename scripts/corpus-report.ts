/**
 * Runs the parser + classifier over every real rule file in corpus/ and
 * reports where rules actually land. The point is not "does it crash" —
 * it's WHICH CHECK each real-world rule routes to.
 *
 * The number that matters: how many real rules still land on the generic
 * `deterministic` keyword path. That's the path every false positive
 * found on 2026-08-30 came from, so it's the false-positive risk surface.
 * Each new structured primitive should move rules OUT of it.
 *
 * Usage: npx tsx scripts/corpus-report.ts [--show-deterministic]
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseClaudeMd } from "../src/parsers/claudeMdParser.js";
import { classifyRule } from "../src/checks/classify.js";

const CORPUS_DIR = "corpus";
const showDeterministic = process.argv.includes("--show-deterministic");

let files: string[];
try {
  files = readdirSync(CORPUS_DIR).filter((f) => statSync(join(CORPUS_DIR, f)).isFile());
} catch {
  console.error(`No ${CORPUS_DIR}/ directory. Run: bash scripts/fetch-corpus.sh`);
  process.exit(1);
}

const counts: Record<string, number> = {};
const deterministicSamples: { file: string; title: string; patterns: string[] }[] = [];
const crashed: { file: string; error: string }[] = [];
let totalRules = 0;
let emptyFiles = 0;

for (const file of files) {
  const path = join(CORPUS_DIR, file);
  try {
    const rules = parseClaudeMd(path, "project");
    if (rules.length === 0) {
      emptyFiles++;
      continue;
    }
    for (const rule of rules) {
      totalRules++;
      const c = classifyRule(rule);
      counts[c.kind] = (counts[c.kind] ?? 0) + 1;
      if (c.kind === "deterministic") {
        deterministicSamples.push({ file, title: rule.title.slice(0, 60), patterns: c.patterns });
      }
    }
  } catch (err) {
    crashed.push({ file, error: err instanceof Error ? err.message : String(err) });
  }
}

console.log(`\nCorpus: ${files.length} real rule files, ${totalRules} rules parsed`);
if (emptyFiles > 0) console.log(`  (${emptyFiles} files produced zero rules — prose-only or unparseable structure)`);

console.log(`\nWhere real-world rules actually route:`);
const ordered = Object.entries(counts).sort((a, b) => b[1] - a[1]);
for (const [kind, n] of ordered) {
  const pct = ((n / totalRules) * 100).toFixed(1);
  const flag = kind === "deterministic" ? "  <-- keyword path: false-positive risk surface" : "";
  console.log(`  ${kind.padEnd(18)} ${String(n).padStart(5)}  ${pct.padStart(5)}%${flag}`);
}

if (crashed.length > 0) {
  console.log(`\nCRASHED on ${crashed.length} file(s) — these are real robustness bugs:`);
  for (const c of crashed.slice(0, 10)) console.log(`  ${c.file}: ${c.error}`);
} else {
  console.log(`\nNo crashes across ${files.length} real files.`);
}

if (showDeterministic && deterministicSamples.length > 0) {
  console.log(`\nRules still on the keyword path (first 40) — each is a candidate for a new structured primitive:`);
  for (const s of deterministicSamples.slice(0, 40)) {
    console.log(`  [${s.patterns.join(", ").slice(0, 40)}]  ${s.title}`);
  }
}
console.log();
