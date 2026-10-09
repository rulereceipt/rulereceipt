/**
 * SHADOW false-accusation measurement.
 *
 * The frozen FA corpora (tests/fixtures/fa-corpus-v1|v2|v3) are synthetic and
 * known-CLEAN — a correct tool produces zero Broken on them (that is the
 * false-accusation-rate.ts gate). This script runs the SHADOW signals over the
 * same corpus and counts how often each one FIRES. Because every session is
 * clean, every fire is a candidate false positive to read before any signal is
 * promoted to a real Broken verdict (the hard rule: measure FA first).
 *
 * This is a REPORT, not a gate — shadow signals are advisory. Run:
 *   npx tsx scripts/shadow-fa.ts            # all three corpora
 *   npx tsx scripts/shadow-fa.ts --v2       # one corpus
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { readTranscriptFromFile } from "../src/parsers/transcriptParser.js";
import { parseClaudeMd } from "../src/parsers/readClaudeMd.js";
import { detectShadowSignals } from "../src/checks/shadowSignals.js";
import { detectGuardTamper } from "../src/checks/guardTamper.js";
import type { TranscriptEvent } from "../src/types.js";

const ROOT = join(import.meta.dirname, "..", "tests", "fixtures");
const only = process.argv.find((a) => /^--v[123]$/.test(a));
const corpora = (only ? [only.slice(2)] : ["v1", "v2", "v3"]).map((v) => `fa-corpus-${v}`).filter((d) => existsSync(join(ROOT, d)));

type Row = { signal: string; corpus: string; rulesFile: string; session: string; evidence: string };
const fires: Row[] = [];
let reports = 0;

for (const corpus of corpora) {
  const base = join(ROOT, corpus);
  const rulesDir = join(base, "rules");
  const sessDir = join(base, "sessions");
  const rulesFiles = readdirSync(rulesDir).filter((f) => statSync(join(rulesDir, f)).isFile());
  const sessions = readdirSync(sessDir).filter((f) => f.endsWith(".jsonl")).sort();
  const parsed = new Map<string, TranscriptEvent[]>();
  for (const s of sessions) parsed.set(s, readTranscriptFromFile(join(sessDir, s)));

  for (const rf of rulesFiles) {
    const rules = parseClaudeMd(join(rulesDir, rf), "project");
    const hasBranchRule = rules.some((r) => /\bbranch\b|\bpush\b|\bmain\b/i.test(`${r.title} ${r.text}`));
    for (const [s, events] of parsed) {
      reports += 1;
      for (const f of detectShadowSignals(rules, events)) fires.push({ signal: f.signal, corpus, rulesFile: rf, session: s, evidence: f.evidence });
      for (const f of detectGuardTamper(events, { hasBranchRule })) fires.push({ signal: f.kind, corpus, rulesFile: rf, session: s, evidence: f.evidence });
    }
  }
}

const SIGNALS = ["zero-tests", "claimed-action-no-command", "env-strict", "hooks-disabled", "no-verify", "hook-config-edit"];
console.log(`SHADOW FA — corpora: ${corpora.join(", ")}`);
console.log(`Clean reports measured: ${reports} (rules files × sessions). Every fire below is a candidate false positive.\n`);
console.log("signal                       fires   distinct-evidence");
for (const sig of SIGNALS) {
  const rows = fires.filter((f) => f.signal === sig);
  const distinct = new Set(rows.map((r) => r.evidence)).size;
  console.log(`  ${sig.padEnd(27)} ${String(rows.length).padStart(5)}   ${distinct}`);
}
const total = fires.length;
console.log(`\nTotal fires: ${total}  (FA rate on the clean corpus: ${((fires.length / Math.max(reports, 1)) * 100).toFixed(2)}% of reports)`);

if (total > 0) {
  console.log(`\nEvery fire (read each — the corpus is clean, so these are the false-positive candidates):`);
  for (const r of fires) console.log(`  [${r.signal}] ${r.corpus}/${r.rulesFile} × ${r.session}\n      ${r.evidence.replace(/\s+/g, " ").slice(0, 160)}`);
} else {
  console.log(`\nNo shadow signal fired on any clean report. FA = 0 across ${corpora.join(", ")}.`);
}
