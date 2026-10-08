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
import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
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

/**
 * --frozen: run the committed, versioned, synthetic benchmark
 * (tests/fixtures/fa-corpus-v1) instead of the maintainer's local corpus +
 * largest real sessions. This is the number that only moves when the CHECKERS
 * change — it reads no home directory, so it is reproducible by anyone from the
 * repo alone. The non-frozen mode stays a local spot-check only, NOT the
 * published number.
 */
const FROZEN = process.argv.includes("--frozen");
const FROZEN_DIR = join(
  process.cwd(),
  "tests",
  "fixtures",
  process.argv.includes("--v3") ? "fa-corpus-v3" : process.argv.includes("--v2") ? "fa-corpus-v2" : "fa-corpus-v1"
);
const CORPUS = FROZEN ? join(FROZEN_DIR, "rules") : join(process.cwd(), "corpus");
const sessionCountArg = process.argv[2] && !process.argv[2].startsWith("--") ? Number(process.argv[2]) : 5;
const sessionCount = sessionCountArg;

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

const sessions = FROZEN
  ? readdirSync(join(FROZEN_DIR, "sessions")).filter((f) => f.endsWith(".jsonl")).sort().map((f) => join(FROZEN_DIR, "sessions", f))
  : pinnedSessions(sessionCount);
if (sessions.length === 0) {
  console.error("No session transcripts found — nothing to measure. Not reporting a rate.");
  process.exit(1);
}
if (FROZEN) {
  const ver = process.argv.includes("--v3")
    ? "fa-corpus-v3 (VCS/image/package deletes are not data-store wipes)"
    : process.argv.includes("--v2")
      ? "fa-corpus-v2 (hard cases; we keep cases we fail)"
      : "fa-corpus-v1 (easy near-misses)";
  console.log(`FROZEN BENCHMARK: ${ver} — committed, synthetic, reproducible; no home scan\n`);
}

/**
 * Each input is printed with the hash of the bytes actually read.
 *
 * "Pins its inputs" was not true when this script was first published, and
 * the way it failed is worth keeping: the largest sessions on this machine
 * include the session doing the measuring, which is appended to while the
 * run happens. Two runs of identical code returned 26 and 27 distinct FAIL
 * texts because ~2MB of transcript arrived in between. The selection rule
 * was deterministic; the bytes were not.
 *
 * A hash does not stop that. It makes it visible: two runs are comparable
 * only when these lines match, and a changed hash on an unchanged filename
 * means the input moved, not the tool.
 */
console.log(`Sessions (${FROZEN ? "frozen set" : "largest " + sessions.length}, deterministic order):`);
for (const s of sessions) {
  const bytes = readFileSync(s);
  const sha = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
  console.log(`  sha256:${sha}  ${(bytes.length / 1024).toFixed(0)} KB  ${s.replace(homedir(), "~")}`);
}

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

// In FROZEN mode this is a GATE, not a report: the frozen corpus is synthetic
// and known-clean, so any report carrying a FAIL is a regression. Fail by EXIT
// CODE (never require a caller to grep this output) — 2026-10-07.
if (FROZEN && withFail > 0) {
  console.error(`\nGATE FAILED: frozen corpus must have 0 reports carrying a FAIL; got ${withFail} of ${reports}.`);
  process.exit(1);
}

const showAll = process.argv.includes("--all");
const top = [...texts.entries()].sort((a, b) => b[1] - a[1]).slice(0, showAll ? Infinity : 8);
if (top.length > 0) {
  console.log(`\n${showAll ? "All" : "Most frequent"} FAIL texts:`);
  for (const [text, n] of top) console.log(`  ${String(n).padStart(5)}x  ${text.replace(/\s+/g, " ").slice(0, showAll ? 200 : 110)}`);
}
