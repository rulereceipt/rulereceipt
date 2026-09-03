/**
 * How much of a real rules file could actually be ENFORCED, as opposed to
 * checked after the fact?
 *
 * The three buckets come from konsta95 in anthropics/claude-code#90542:
 *
 *   toolCallPredicate — expressible as "when this tool is called with these
 *     arguments, block it". A PreToolUse hook holds it without the model's
 *     cooperation.
 *   artifactGateable  — about process or ordering, but the thing it requires
 *     leaves a durable trace (a test run, a review, a receipt) that a gate can
 *     demand before permitting the next step. Includes Stop-shaped rules,
 *     where the claim and the evidence for it are both in the turn record.
 *   proseOnly         — no event to fire on and no artifact to hold. Tone,
 *     priority, taste, judgment.
 *
 * WHY THIS IS SAMPLED AND MODEL-JUDGED RATHER THAN SWEPT WITH REGEX
 *
 * A regex version of this was written first and thrown away. Hand-checking
 * fifteen of its toolCallPredicate hits found two correct: a path pattern
 * matched any word containing a full stop, so "under the License." and
 * "Params" were classified as gateable tool calls. Precision was around 10%,
 * which makes a whole-corpus percentage worse than no number at all, because
 * it looks authoritative.
 *
 * Deciding whether a gate could hold a rule is a judgment about meaning. That
 * is the same conclusion this project reached about rules in general, so the
 * method has to match: sample, judge, and publish an interval with a measured
 * error rate rather than a false-precision integer over all 8,803.
 *
 * The sample is drawn with a seeded PRNG so the same seed reproduces the same
 * rules on any machine. Anyone can redraw it and disagree with the labels.
 *
 * Usage:
 *   npx tsx scripts/enforceability-sample.ts                  # draw + write sample
 *   npx tsx scripts/enforceability-sample.ts --judge          # + classify via API
 *   npx tsx scripts/enforceability-sample.ts --judge --n 300 --seed 7
 *
 * Hand-labelling: the drawn sample is written to enforceability-sample.jsonl
 * with an empty "human" field. Fill that field in on as many rows as you can
 * stand (fifty is enough to bound the error), then re-run with --judge and the
 * agreement rate is reported against them.
 */
import { readdirSync, statSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { parseClaudeMd } from "../src/parsers/readClaudeMd.js";
import { classifyRule } from "../src/checks/classify.js";

const MODEL = "claude-sonnet-4-5-20250929";
const BUCKETS = ["toolCallPredicate", "artifactGateable", "proseOnly"] as const;
type Bucket = (typeof BUCKETS)[number];

const argv = process.argv.slice(2);
const flag = (name: string, fallback: number) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : fallback;
};
const SAMPLE_N = flag("n", 300);
const SEED = flag("seed", 1);
const doJudge = argv.includes("--judge");
const OUT = "enforceability-sample.jsonl";

/** mulberry32 — small, seeded, reproducible across machines. */
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
 * Wilson score interval. Preferred over the normal approximation because the
 * proportions here are small enough that a naive interval would run below
 * zero, and a bucket reported as "4.9% ± 6" is not a finding.
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
      text: (rule.text ?? "").replace(/\s+/g, " ").trim().slice(0, 600),
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

console.log(`Population: ${pool.length} real rules across ${corpusDir}/`);
console.log(`Sample:     ${sample.length}  (seed ${SEED})\n`);

// Preserve any hand labels already recorded against this seed.
const priorHuman = new Map<string, string>();
if (existsSync(OUT)) {
  for (const line of readFileSync(OUT, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row.human) priorHuman.set(`${row.file}::${row.title}`, row.human);
    } catch {
      /* malformed row, skip */
    }
  }
  if (priorHuman.size > 0) console.log(`Carrying forward ${priorHuman.size} existing hand labels.\n`);
}

// ---------------------------------------------------------------- judge

const RESULT_TOOL = {
  name: "report_bucket",
  description: "Report which enforcement bucket this rule falls into.",
  input_schema: {
    type: "object" as const,
    properties: {
      bucket: { type: "string", enum: [...BUCKETS] },
      reason: { type: "string", description: "One sentence. Name the tool call or artifact if there is one." },
    },
    required: ["bucket", "reason"],
  },
};

const PROMPT = `You are classifying a single rule taken from a real CLAUDE.md / AGENTS.md style file, by HOW IT COULD BE ENFORCED in Claude Code. This is not about whether the rule is good, or whether a human could tell if it was followed. It is about whether a hook could hold it.

toolCallPredicate — the rule can be expressed as "when this tool is called with these arguments, block the call". It names a concrete action and target: a command to run, a file or glob to touch, a git operation, a network destination. A PreToolUse hook can refuse it before it happens, with no cooperation from the model.

artifactGateable — the rule is about process or ordering, and the thing it requires leaves a durable trace that a gate can demand: a test run, a build, a lint pass, a review, an approval, a receipt. A gate asks for the artifact rather than asking whether the process happened. Also use this for rules where a claim can be checked against the turn record at the moment the turn tries to end, e.g. "don't say it works until you've run it" — the run leaves a tool result and the claim leaves text.

proseOnly — there is no event to fire on and no artifact to hold. Style, tone, priority, taste, architectural preference, "write clear code", "be concise", "prefer composition". A human can judge it; a gate cannot.

Judge only what the rule says. Do not be generous: if enforcing it would require the model to cooperate honestly, it is proseOnly. If you are torn between two buckets, choose the weaker one.`;

async function judge(client: Anthropic, r: { title: string; text: string }): Promise<{ bucket: Bucket; reason: string } | null> {
  try {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 300,
      tools: [RESULT_TOOL],
      tool_choice: { type: "tool", name: "report_bucket" },
      messages: [{ role: "user", content: `${PROMPT}\n\nRULE TITLE: ${r.title}\nRULE BODY: ${r.text}` }],
    });
    const block = res.content.find((b) => b.type === "tool_use");
    if (!block || block.type !== "tool_use") return null;
    return block.input as { bucket: Bucket; reason: string };
  } catch (err) {
    console.error(`  ! ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

const rows: Record<string, unknown>[] = [];

if (doJudge) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("--judge needs ANTHROPIC_API_KEY. Sample was still written; run again with the key set.");
  } else {
    const client = new Anthropic({ apiKey });
    const counts: Record<Bucket, number> = { toolCallPredicate: 0, artifactGateable: 0, proseOnly: 0 };
    let judged = 0;
    let failed = 0;

    // Small concurrency: enough to finish in a couple of minutes, low enough
    // not to trip rate limits on a personal key.
    const QUEUE = 6;
    let cursor = 0;
    const results = new Array<{ bucket: Bucket; reason: string } | null>(sample.length);
    await Promise.all(
      Array.from({ length: QUEUE }, async () => {
        for (;;) {
          const i = cursor++;
          if (i >= sample.length) return;
          results[i] = await judge(client, sample[i]);
          const done = results.filter((x) => x !== undefined).length;
          if (done % 25 === 0) process.stderr.write(`  judged ~${done}/${sample.length}\r`);
        }
      })
    );

    sample.forEach((r, i) => {
      const v = results[i];
      if (v) {
        counts[v.bucket] += 1;
        judged += 1;
      } else {
        failed += 1;
      }
      rows.push({
        file: r.file,
        title: r.title,
        text: r.text,
        cliKind: r.kind,
        model: v?.bucket ?? null,
        reason: v?.reason ?? null,
        human: priorHuman.get(`${r.file}::${r.title}`) ?? "",
      });
    });

    console.log(`\nJudged ${judged}/${sample.length}${failed ? ` (${failed} failed)` : ""}\n`);
    console.log(`Enforceability, sampled estimate with 95% Wilson intervals:\n`);
    for (const b of BUCKETS) {
      const [lo, hi] = wilson(counts[b], judged);
      const p = ((counts[b] / judged) * 100).toFixed(1);
      console.log(
        `  ${b.padEnd(20)} ${String(counts[b]).padStart(4)}/${judged}   ${p.padStart(5)}%   [${(lo * 100).toFixed(1)}–${(hi * 100).toFixed(1)}%]`
      );
    }

    // Agreement against hand labels, which is the only real error bound here.
    const labelled = rows.filter((r) => r.human && r.model);
    if (labelled.length > 0) {
      const agree = labelled.filter((r) => r.human === r.model).length;
      const [lo, hi] = wilson(agree, labelled.length);
      console.log(
        `\nAgreement with hand labels: ${agree}/${labelled.length} = ${((agree / labelled.length) * 100).toFixed(1)}%  [${(lo * 100).toFixed(1)}–${(hi * 100).toFixed(1)}%]`
      );
      const confusion: Record<string, number> = {};
      for (const r of labelled) {
        if (r.human !== r.model) confusion[`${r.human} → ${r.model}`] = (confusion[`${r.human} → ${r.model}`] ?? 0) + 1;
      }
      const wrong = Object.entries(confusion).sort((a, b) => b[1] - a[1]);
      if (wrong.length) {
        console.log(`  disagreements (hand → model):`);
        wrong.forEach(([k, v]) => console.log(`    ${k}  ${v}`));
      }
    } else {
      console.log(`\nNo hand labels yet. Fill the "human" field in ${OUT} on ~50 rows,`);
      console.log(`then re-run --judge to get the agreement rate. Until then these`);
      console.log(`percentages have no measured error bound and should not be published.`);
    }
  }
}

if (rows.length === 0) {
  sample.forEach((r) =>
    rows.push({
      file: r.file,
      title: r.title,
      text: r.text,
      cliKind: r.kind,
      model: null,
      reason: null,
      human: priorHuman.get(`${r.file}::${r.title}`) ?? "",
    })
  );
}

writeFileSync(OUT, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
console.log(`\nWrote ${rows.length} rows to ${OUT}`);
console.log(`Hand-label by setting "human" to one of: ${BUCKETS.join(" | ")}`);
