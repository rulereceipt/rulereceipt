/**
 * The headline safety number: what share of reports accuse someone wrongly.
 *
 * Every rules file in corpus/ is run against every session in a pinned set,
 * and the script counts reports containing at least one FAIL. It is a
 * CEILING on false accusations, not a count of them — the corpus rules
 * belong to other people's projects and the sessions do not, so a FAIL here
 * is almost always spurious by construction. That is the point: the number
 * should be near zero, and any movement in it is a real change in how
 * readily the tool accuses.
 *
 * Written 2026-09-14. The 15.8% -> 2.9% figures already published came from
 * an ad-hoc script that was not kept, so its session set cannot be verified
 * against this one. Numbers from this script are comparable to each other
 * from here on; treat the older pair as history rather than a baseline.
 *
 * Session selection is deterministic and stated in the output, because a
 * measurement whose inputs move is not a measurement.
 *
 * Usage: npx tsx scripts/false-accusation-rate.ts [sessionCount] [--all]
 */
import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseClaudeMd } from "../src/parsers/readClaudeMd.js";
import { readTranscriptFromFile } from "../src/parsers/transcriptParser.js";
import { classifyRules } from "../src/checks/classify.js";
import { runDeterministicChecks } from "../src/checks/deterministicChecks.js";
import { runIfEditThenTestChecks } from "../src/checks/ifEditThenTest.js";
import { runGitBranchPolicyChecks } from "../src/checks/gitBranchPolicy.js";
import { runCodeContentChecks } from "../src/checks/codeContent.js";
import { runFileLifecycleChecks } from "../src/checks/fileLifecycle.js";
import { runClaimEvidenceChecks } from "../src/checks/claimEvidence.js";
import type { CheckResult, TranscriptEvent } from "../src/types.js";

const CORPUS = join(process.cwd(), "corpus");
const sessionCount = Number(process.argv[2] ?? 5);

/** The N largest transcripts under any ~/.claude* projects dir; size then path. */
function pinnedSessions(n: number): string[] {
  // Employer sessions are excluded deliberately. This number gets published
  // and the FAIL texts are printed alongside it; work content must not be
  // able to reach either.
  const roots = readdirSync(homedir())
    .filter((d) => d.startsWith(".claude") && !d.includes("office"))
    .map((d) => join(homedir(), d, "projects"))
    .filter((p) => existsSync(p));
  const files: { path: string; size: number }[] = [];
  for (const root of roots) {
    for (const proj of readdirSync(root)) {
      const dir = join(root, proj);
      let entries: string[];
      try { entries = readdirSync(dir); } catch { continue; }
      for (const f of entries) {
        if (!f.endsWith(".jsonl")) continue;
        try { files.push({ path: join(dir, f), size: statSync(join(dir, f)).size }); } catch { /* unreadable */ }
      }
    }
  }
  return files.sort((a, b) => b.size - a.size || a.path.localeCompare(b.path)).slice(0, n).map((f) => f.path);
}

function check(rulesFilePath: string, events: TranscriptEvent[]): CheckResult[] {
  const rules = parseClaudeMd(rulesFilePath, "project");
  const cls = classifyRules(rules);
  const of = (k: string) => cls.filter((c) => c.kind === k) as never;
  return [
    ...runDeterministicChecks(of("deterministic"), events),
    ...runIfEditThenTestChecks(of("ifEditThenTest"), events),
    ...runGitBranchPolicyChecks(of("gitBranchPolicy"), events),
    ...runCodeContentChecks(of("codeContent"), events),
    ...runFileLifecycleChecks(of("fileLifecycle"), events),
    ...runClaimEvidenceChecks(of("claimEvidence"), events),
  ];
}

const sessions = pinnedSessions(sessionCount);
if (sessions.length === 0) {
  console.error("No session transcripts found — nothing to measure. Not reporting a rate.");
  process.exit(1);
}

console.log(`Sessions (largest ${sessions.length}, deterministic order):`);
for (const s of sessions) console.log(`  ${s.replace(homedir(), "~")}  (${(statSync(s).size / 1024).toFixed(0)} KB)`);

const parsed = sessions.map(readTranscriptFromFile);
const files = readdirSync(CORPUS).filter((f) => statSync(join(CORPUS, f)).isFile());

let reports = 0;
let withFail = 0;
let failVerdicts = 0;
const texts = new Map<string, number>();

for (const f of files) {
  for (const events of parsed) {
    const results = check(join(CORPUS, f), events);
    reports += 1;
    const fails = results.filter((r) => r.status === "FAIL");
    if (fails.length > 0) withFail += 1;
    failVerdicts += fails.length;
    for (const fail of fails) texts.set(fail.evidence, (texts.get(fail.evidence) ?? 0) + 1);
  }
}

console.log(`\nCorpus: ${files.length} rules files x ${sessions.length} sessions = ${reports} reports`);
console.log(`Reports carrying at least one FAIL: ${withFail}  (${((withFail / reports) * 100).toFixed(1)}%)`);
console.log(`Total FAIL verdicts: ${failVerdicts}`);
console.log(`Distinct FAIL texts: ${texts.size}`);

const showAll = process.argv.includes("--all");
const top = [...texts.entries()].sort((a, b) => b[1] - a[1]).slice(0, showAll ? Infinity : 8);
if (top.length > 0) {
  console.log(`\n${showAll ? "All" : "Most frequent"} FAIL texts:`);
  for (const [text, n] of top) console.log(`  ${String(n).padStart(5)}x  ${text.replace(/\s+/g, " ").slice(0, showAll ? 200 : 110)}`);
}
