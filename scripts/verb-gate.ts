/**
 * Which gate admitted each rule, and what the discarded bucket is made of.
 *
 * Asked for by stonianua on anthropics/claude-code#91424, 2026-09-16: split
 * the judgment share into ratified-judgment, inferred-from-verb and
 * never-entered, and tag the discarded bucket by verb.
 *
 * The question underneath it: "For judgment calls, present three candidates
 * and stop" is discarded as documentation and becomes a rule the moment "you
 * must" is inserted. If bare imperatives are disproportionately the process
 * and ordering rules, the coverage figure flatters itself by dropping
 * exactly the class the issue is about.
 *
 * One probe was written for this and thrown away: "would prepending `You
 * must` rescue it?" measures nothing, because `must` is itself in
 * DIRECTIVE_LANGUAGE, so it rescues every item including table rows. It
 * returned 12,428 of 12,428 and the sample was full of "Copilot analyzes
 * your request". A test that cannot fail is decoration, and that one could
 * not fail.
 *
 * What replaced it needs no judgment: rank the word each discarded item
 * STARTS with. If unlisted instruction verbs sit near the top, the closed
 * list is eating rules. If it is articles and product names, the bucket is
 * documentation and the coverage figure is honest.
 *
 * Usage: npx tsx scripts/verb-gate.ts
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseClaudeMd } from "../src/parsers/readClaudeMd.js";
import {
  classifyRule,
  TITLE_OPENS_WITH_DIRECTIVE,
  DIRECTIVE_LANGUAGE,
  IMPERATIVE_INSTRUCTION,
  isEventRecord,
  isCommandDocumentation,
} from "../src/checks/classify.js";
import type { Rule } from "../src/types.js";

const CORPUS = join(process.cwd(), "corpus");

/** Which gate admitted this rule — first one that fires, in source order. */
function admittedBy(r: Rule): string {
  if (TITLE_OPENS_WITH_DIRECTIVE.test(r.title)) return "title_directive";
  if (DIRECTIVE_LANGUAGE.test(`${r.title} ${r.text}`)) return "modal";
  if (IMPERATIVE_INSTRUCTION.test(r.title) || IMPERATIVE_INSTRUCTION.test(r.text)) return "verb_list";
  return "(unknown)";
}

function discardedBy(r: Rule): string {
  if (isEventRecord(r)) return "event_record";
  if (isCommandDocumentation(r)) return "command_doc";
  return "no_directive_found";
}

/** The first word of the first non-empty line, stripped of markdown. */
function opener(r: Rule): string | undefined {
  const first = `${r.title}\n${r.text}`.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return first
    .replace(/^[-*+>#\s]+/, "")
    .replace(/^[`*_[\]("']+/, "")
    .match(/^([A-Za-z][A-Za-z-]*)/)?.[1]
    ?.toLowerCase();
}

const admitted = new Map<string, number>();
const judgmentBy = new Map<string, number>();
const discarded = new Map<string, number>();
const openers = new Map<string, number>();
let total = 0;
let rules = 0;
let drops = 0;

for (const f of readdirSync(CORPUS)) {
  if (!statSync(join(CORPUS, f)).isFile()) continue;
  for (const r of parseClaudeMd(join(CORPUS, f), "project")) {
    total++;
    const c = classifyRule(r);
    if (c.kind === "notARule") {
      drops++;
      const why = discardedBy(r);
      discarded.set(why, (discarded.get(why) ?? 0) + 1);
      if (why === "no_directive_found") {
        const w = opener(r);
        if (w) openers.set(w, (openers.get(w) ?? 0) + 1);
      }
      continue;
    }
    rules++;
    const gate = admittedBy(r);
    admitted.set(gate, (admitted.get(gate) ?? 0) + 1);
    if (c.kind === "judgment") judgmentBy.set(gate, (judgmentBy.get(gate) ?? 0) + 1);
  }
}

const pct = (n: number, d: number) => `${((n / d) * 100).toFixed(1)}%`;
const onList = (w: string) => IMPERATIVE_INSTRUCTION.test(`. ${w} x`);

console.log(`Corpus: ${total} items, ${rules} genuine rules, ${drops} discarded\n`);

console.log("Which gate admitted each genuine rule:");
for (const [k, v] of [...admitted].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(16)} ${String(v).padStart(6)}  ${pct(v, rules)}`);
}

const jt = [...judgmentBy.values()].reduce((a, b) => a + b, 0);
console.log(`\nThe judgment bucket (${jt}), split as asked:`);
for (const [k, v] of [...judgmentBy].sort((a, b) => b[1] - a[1])) {
  const label = k === "verb_list" ? "inferred-from-verb (bare imperative, closed list)" : "ratified (explicit must / never / no X)";
  console.log(`  ${k.padEnd(16)} ${String(v).padStart(6)}  ${pct(v, jt)}   ${label}`);
}

console.log(`\nWhy the ${drops} discarded were discarded:`);
for (const [k, v] of [...discarded].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(18)} ${String(v).padStart(6)}  ${pct(v, drops)}`);
}

const ranked = [...openers].sort((a, b) => b[1] - a[1]);
const counted = [...openers.values()].reduce((a, b) => a + b, 0);
console.log(`\nWhat the ${counted} no-directive items start with — top 25:\n`);
for (const [w, n] of ranked.slice(0, 25)) {
  console.log(`  ${String(n).padStart(5)}  ${onList(w) ? "[on list]" : "[not]    "}  ${w}`);
}
console.log(`\nDistinct opening words: ${ranked.length}.`);
console.log("Read the [not] entries: instruction verbs there are rules the closed list is eating.");
