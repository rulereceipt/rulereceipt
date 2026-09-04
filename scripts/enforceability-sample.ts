/**
 * How much of a real rules file could actually be ENFORCED, rather than
 * merely checked after the fact?
 *
 * The three buckets come from konsta95 in anthropics/claude-code#90542:
 *
 *   [t] toolCallPredicate — expressible as "when this tool is called with
 *       these arguments, block it". Names a concrete action and target: a
 *       command, a file or glob, a git operation. A PreToolUse hook holds it
 *       without the model cooperating.
 *   [a] artifactGateable  — about process or ordering, but the thing it
 *       requires leaves a durable trace a gate can demand first: a test run,
 *       a build, a lint pass, a review, a receipt. Also covers rules where a
 *       claim can be checked against the turn record as the turn tries to end
 *       ("don't say it works until you've run it").
 *   [p] proseOnly         — no event to fire on, no artifact to hold. Tone,
 *       priority, taste, architectural preference.
 *
 * WHY THIS IS HAND-LABELLED
 *
 * A regex sweep was written first and thrown away. Hand-checking fifteen of
 * its toolCallPredicate hits found two correct — the path pattern matched any
 * word containing a full stop, so "under the License." and "Params" came back
 * as gateable tool calls. Roughly 10% precision, published as a whole-corpus
 * percentage, is worse than no number, because it reads as authoritative.
 *
 * An API-judged version came next. It is still supported (--judge), but a
 * model labelling the sample and a model checking those labels is circular:
 * if both passes share a blind spot they agree confidently and are both
 * wrong. For a figure that has to survive an audit, human labels are the only
 * ones with no error rate to disclose.
 *
 * So the default path is: draw a seeded sample, hand-label it, report
 * proportions with Wilson intervals. A model pass can be run alongside, but
 * it is reported as a separate column and never as ground truth.
 *
 * Usage:
 *   npx tsx scripts/enforceability-sample.ts                 # draw + write worksheet
 *   npx tsx scripts/enforceability-sample.ts --n 100 --seed 1
 *   npx tsx scripts/enforceability-sample.ts --score         # read answers, report
 *   npx tsx scripts/enforceability-sample.ts --judge         # optional model pass (needs API key)
 *
 * The worksheet is enforceability-worksheet.txt. Each block ends in
 * "ANSWER:" — put a single letter after it: t, a or p. Blank rows are
 * skipped, so labelling can stop at any point and still produce a valid
 * estimate over however many were done.
 */
import { readdirSync, statSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseClaudeMd } from "../src/parsers/readClaudeMd.js";
import { classifyRule } from "../src/checks/classify.js";

const BUCKETS = { t: "toolCallPredicate", a: "artifactGateable", p: "proseOnly" } as const;
type Letter = keyof typeof BUCKETS;
const WORKSHEET = "enforceability-worksheet.txt";

const argv = process.argv.slice(2);
const num = (name: string, fallback: number) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : fallback;
};
const SAMPLE_N = num("n", 100);
const SEED = num("seed", 1);

/** mulberry32 — small, seeded, reproducible on any machine. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    try {
      if (statSync(full).isDirectory()) out.push(...walk(full));
      else out.push(full);
    } catch {
      /* unreadable, skip */
    }
  }
  return out;
}

/**
 * Wilson score interval. Preferred over the normal approximation because at
 * these proportions and this n a naive interval runs below zero, and
 * "4.9% ± 6" is not a finding.
 */
function wilson(successes: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 0];
  const p = successes / n;
  const d = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (centre - spread) / d), Math.min(1, (centre + spread) / d)];
}

// ---------------------------------------------------------------- draw

const corpusDir = argv.find((a) => !a.startsWith("--") && !/^\d+$/.test(a)) ?? "corpus";
const pool: { file: string; title: string; text: string; kind: string }[] = [];
for (const file of walk(corpusDir)) {
  for (const rule of parseClaudeMd(file, "project")) {
    const kind = classifyRule(rule).kind;
    if (kind === "notARule") continue;
    pool.push({
      file: file.replace(`${corpusDir}/`, ""),
      title: rule.title.replace(/\s+/g, " ").trim(),
      text: (rule.text ?? "").replace(/\s+/g, " ").trim(),
      kind,
    });
  }
}

const rand = rng(SEED);
const idx = pool.map((_, i) => i);
for (let i = idx.length - 1; i > 0; i--) {
  const j = Math.floor(rand() * (i + 1));
  [idx[i], idx[j]] = [idx[j], idx[i]];
}
const sample = idx.slice(0, Math.min(SAMPLE_N, pool.length)).map((i) => pool[i]);

// ---------------------------------------------------------------- score

/**
 * Reads the answers back out of the worksheet, tolerating blank rows.
 *
 * Keyed on the rule's own title, never on its position. The population this
 * samples from changes whenever the classifier does — the 2026-09-04 fix
 * moved 390 items out of it — so a redraw puts different rules at the same
 * block numbers. Carrying answers forward positionally would silently
 * reattach a label to a rule nobody ever looked at, which is the exact
 * failure this whole measurement exists to avoid.
 */
function readAnswers(): { byIndex: Map<number, Letter>; byTitle: Map<string, Letter> } {
  const byIndex = new Map<number, Letter>();
  const byTitle = new Map<string, Letter>();
  if (!existsSync(WORKSHEET)) return { byIndex, byTitle };
  let current = 0;
  let currentTitle = "";
  for (const line of readFileSync(WORKSHEET, "utf8").split("\n")) {
    const head = line.match(/^\[(\d+)\]\s*(.*)$/);
    if (head) {
      current = Number(head[1]);
      currentTitle = head[2].trim();
    }
    const ans = line.match(/^ANSWER:\s*([tap])\b/i);
    if (ans && current > 0) {
      const letter = ans[1].toLowerCase() as Letter;
      byIndex.set(current, letter);
      if (currentTitle) byTitle.set(currentTitle, letter);
    }
  }
  return { byIndex, byTitle };
}

if (argv.includes("--score")) {
  const { byIndex: answers } = readAnswers();
  if (answers.size === 0) {
    console.error(`No answers found in ${WORKSHEET}.`);
    console.error(`Put a single letter (t / a / p) after "ANSWER:" on each block you label.`);
    process.exit(1);
  }
  const counts: Record<string, number> = { toolCallPredicate: 0, artifactGateable: 0, proseOnly: 0 };
  for (const letter of answers.values()) counts[BUCKETS[letter]] += 1;
  const n = answers.size;

  console.log(`Population : ${pool.length} real rules`);
  console.log(`Sample     : ${sample.length} drawn (seed ${SEED})`);
  const by = argv.includes("--by-model") ? "by a model (NOT ground truth)" : "by hand";
  console.log(`Labelled   : ${n} ${by}\n`);
  if (argv.includes("--by-model")) {
    console.log(`  These labels were produced by a model, not a person. A model labelling`);
    console.log(`  and a model checking share blind spots, so this is an estimate with no`);
    console.log(`  measured error rate. Say so wherever it is quoted.\n`);
  }
  console.log(`Enforceability, 95% Wilson intervals:\n`);
  for (const key of ["toolCallPredicate", "artifactGateable", "proseOnly"]) {
    const [lo, hi] = wilson(counts[key], n);
    const p = ((counts[key] / n) * 100).toFixed(1);
    console.log(
      `  ${key.padEnd(20)} ${String(counts[key]).padStart(3)}/${n}  ${p.padStart(5)}%   [${(lo * 100).toFixed(1)}–${(hi * 100).toFixed(1)}%]`
    );
  }
  if (n < 60) {
    console.log(`\n  Note: n=${n}. Intervals this wide are honest but blunt.`);
    console.log(`  Labelling to ~100 roughly halves their width.`);
  }
  process.exit(0);
}

// ---------------------------------------------------------------- worksheet

const { byTitle: existing } = readAnswers();
const lines: string[] = [
  `Enforceability worksheet — ${sample.length} rules drawn from ${pool.length}, seed ${SEED}`,
  ``,
  `For each rule, put ONE letter after ANSWER::`,
  ``,
  `  t = toolCallPredicate  a hook can block the call itself.`,
  `                         Names a command, a path/glob, or a git operation.`,
  `  a = artifactGateable   the rule needs something that leaves a trace a gate`,
  `                         can demand first: a test run, build, lint, review,`,
  `                         approval. Or a claim checkable against the turn record.`,
  `  p = proseOnly          no event, no artifact. Tone, taste, priority, judgment.`,
  ``,
  `If torn between two, choose the weaker one. If enforcing it would need the`,
  `model to cooperate honestly, it is p.`,
  ``,
  `Blank answers are skipped, so stopping early is fine.`,
  `Score with: npx tsx scripts/enforceability-sample.ts --score`,
  ``,
  `${"=".repeat(72)}`,
  ``,
];

sample.forEach((r, i) => {
  const n = i + 1;
  const body = r.text && r.text !== r.title ? r.text.slice(0, 400) : "";
  lines.push(`[${n}] ${r.title.slice(0, 150)}`);
  if (body) lines.push(`    ${body}`);
  lines.push(`    (file: ${r.file.slice(0, 70)} · cli kind: ${r.kind})`);
  // Matched by title, so a label only survives if it is the same rule.
  lines.push(`ANSWER: ${existing.get(r.title.slice(0, 150)) ?? ""}`);
  lines.push(``);
});

writeFileSync(WORKSHEET, `${lines.join("\n")}\n`);
console.log(`Population : ${pool.length} real rules`);
console.log(`Sample     : ${sample.length} (seed ${SEED})`);
if (existing.size) {
  const kept = sample.filter((r) => existing.has(r.title.slice(0, 150))).length;
  console.log(`Carried forward: ${kept} of ${existing.size} previous answers (matched by rule, not position)`);
  if (kept < existing.size) {
    console.log(`  ${existing.size - kept} previous answer(s) dropped — those rules are no longer in the sample.`);
  }
}
console.log(`\nWrote ${WORKSHEET}`);
console.log(`Label each block with t / a / p, then:`);
console.log(`  npx tsx scripts/enforceability-sample.ts --score`);
