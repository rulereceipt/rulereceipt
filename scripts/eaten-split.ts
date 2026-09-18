/**
 * Where would the 295 verb-gate leaks have landed, if the gate had let them in?
 *
 * stonianua, #91424, 2026-09-17: "Curious whether those 295 show up as
 * process/ordering residue (the enriquephl class) more often than as
 * judgment rules — that would tighten whether the optimism sits in the
 * judgment share specifically."
 *
 * The headline is mechanical, because "is this a process rule" is a judgment
 * call and judgment calls do not survive being counted — four passes over the
 * same 25 rules agreed 28% of the time on a taxonomy its own author defined.
 *
 * What IS mechanical: after isNotARule, classifyRule routes on whether the
 * rule carries a usable backtick literal. No literal means judgment. So for
 * each leaked item, ask whether it would have had one. That answers the
 * question as asked — does the optimism sit in the judgment share — without
 * anyone deciding what "process" means.
 *
 * A second, HEURISTIC cut follows it, labelled as such: does the item contain
 * ordering or interaction language (before/after/first/then/until, or
 * ask/present/offer/restate/confirm/wait). That is the enriquephl shape in
 * words rather than in structure. It is offered as colour, not as a count to
 * argue from.
 *
 * Usage: npx tsx scripts/eaten-split.ts [--sample]
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseClaudeMd } from "../src/parsers/readClaudeMd.js";
import { classifyRule, IMPERATIVE_INSTRUCTION } from "../src/checks/classify.js";
import type { Rule } from "../src/types.js";

/** Chosen before looking at the data — the same list used to size the leak. */
const VERBS = [
  "present","restate","ensure","avoid","prefer","implement","prioritise","prioritize","minimise","minimize",
  "maximise","maximize","favour","favor","default","respect","honour","honor","enforce","consider","choose",
  "pick","select","decide","announce","declare","disclose","quote","cite","attribute","acknowledge","reproduce",
  "preserve","retain","separate","isolate","encapsulate","extract","inline","simplify","clarify","justify",
  "summarise","summarize","reject","refuse","abort","halt","escalate","defer","delegate","reuse","derive",
  "enumerate","tag","pin","bound","scope","gate","ratify","adhere","comply","conform","obey","observe","track",
  "record","capture","emit","expose","hide","redact","mask","rotate","revoke","grant","deny","allow","block",
  "warn","notify","alert",
];

/** Copied from classify.ts — the literal extractor the router depends on. */
const BACKTICK = /`([^`\n]+)`/g;

/** Ordering / interaction language. HEURISTIC, reported as such. */
const PROCESS_WORDS = /\b(before|after|first|then|until|unless|prior to|once|while|during|ask|asks|present|offer|restate|confirm|wait|stop and|check with|approval|approve)\b/i;

const CORPUS = join(process.cwd(), "corpus");
const sample = process.argv.includes("--sample");

function opener(r: Rule): string | undefined {
  const first = `${r.title}\n${r.text}`.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return first.replace(/^[-*+>#\s]+/, "").replace(/^[`*_[\]("']+/, "").match(/^([A-Za-z][A-Za-z-]*)/)?.[1]?.toLowerCase();
}

/**
 * Would this item have carried a literal the router could use?
 *
 * Approximates isUsablePattern with its two published rejections: a literal
 * that is only punctuation, and a literal that is a single stopword. Both
 * were real faults — "," appeared 22 times as a checkable pattern.
 */
const STOPWORDS = new Set(["the","a","an","and","or","is","it","to","of","in","on","for","with","as","by","if","not","no","yes","ok"]);
function hasUsableLiteral(r: Rule): boolean {
  for (const m of `${r.title}\n${r.text}`.matchAll(BACKTICK)) {
    const t = m[1].trim();
    if (t.length === 0) continue;
    if (!/[A-Za-z0-9]/.test(t)) continue;
    if (STOPWORDS.has(t.toLowerCase())) continue;
    return true;
  }
  return false;
}

let leaked = 0;
let wouldBeJudgment = 0;
let wouldBeMechanical = 0;
let processShaped = 0;
const examples: string[] = [];

for (const f of readdirSync(CORPUS)) {
  if (!statSync(join(CORPUS, f)).isFile()) continue;
  for (const r of parseClaudeMd(join(CORPUS, f), "project")) {
    if (classifyRule(r).kind !== "notARule") continue;
    const w = opener(r);
    if (!w || !VERBS.includes(w)) continue;
    if (IMPERATIVE_INSTRUCTION.test(`. ${w} x`)) continue; // already on the list, not a leak
    leaked++;
    if (hasUsableLiteral(r)) wouldBeMechanical++; else wouldBeJudgment++;
    if (PROCESS_WORDS.test(`${r.title} ${r.text}`)) processShaped++;
    if (examples.length < 20) examples.push(`${w.padEnd(11)} | ${hasUsableLiteral(r) ? "mech " : "judge"} | ${`${r.title} — ${r.text}`.replace(/\s+/g, " ").slice(0, 96)}`);
  }
}

const pct = (n: number) => `${((n / leaked) * 100).toFixed(1)}%`;
console.log(`Verb-gate leaks (discarded, opening with an unlisted instruction verb): ${leaked}\n`);
console.log("MECHANICAL — where the router would have sent them:");
console.log(`  no usable literal -> judgment   ${String(wouldBeJudgment).padStart(4)}  ${pct(wouldBeJudgment)}`);
console.log(`  usable literal    -> a check    ${String(wouldBeMechanical).padStart(4)}  ${pct(wouldBeMechanical)}`);
console.log(`\nHEURISTIC, offered as colour not as a count to argue from:`);
console.log(`  contains ordering / interaction language  ${String(processShaped).padStart(4)}  ${pct(processShaped)}`);
if (sample) {
  console.log(`\nsample (${examples.length} of ${leaked}):`);
  for (const e of examples) console.log(`  ${e}`);
}
