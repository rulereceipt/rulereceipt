/**
 * What would the PreToolUse guard have blocked, on work that really happened?
 *
 * The guard refuses a command before it runs. That makes its false positives
 * far more expensive than the report's: a wrong line in a report is noise, a
 * wrong refusal stops someone working in their own terminal with no obvious
 * way to tell why. So every rule change that can reach the guard has to be
 * replayed against real sessions before it ships, and every block it
 * produces has to be read by a person.
 *
 * Replays each recorded Bash / Write / Edit call from real transcripts
 * through exactly the code the guard runs, and prints every refusal.
 *
 * Usage: npx tsx scripts/guard-replay.ts [rulesDir] [sessionCount]
 *   rulesDir defaults to the current project, i.e. the rules actually in force.
 */
import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { readTranscriptFromFile } from "../src/parsers/transcriptParser.js";
import { loadRules } from "../src/rules.js";
import { parseClaudeMd } from "../src/parsers/readClaudeMd.js";
import { classifyRules } from "../src/checks/classify.js";
import { commandRunsLiteral, literalIsCommandShaped } from "../src/checks/proposedAction.js";
import { runCodeContentChecks } from "../src/checks/codeContent.js";
import { runFileLifecycleChecks } from "../src/checks/fileLifecycle.js";
import { runGitBranchPolicyChecks } from "../src/checks/gitBranchPolicy.js";
import type { TranscriptEvent } from "../src/types.js";

const rulesDir = process.argv[2] ?? process.cwd();
const sessionCount = Number(process.argv[3] ?? 5);

function pinnedSessions(n: number): string[] {
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

/**
 * `corpus` mode pools every forbidding rule anyone in the corpus wrote and
 * replays the same real sessions against all of them at once.
 *
 * The project's own rules barely exercise the guard - one forbidding rule,
 * no literal ones - so "zero refusals" there says almost nothing. This is
 * the actual false-positive stress test: thousands of other people's
 * prohibitions against commands that really ran and were really fine.
 */
function corpusRules() {
  const dir = join(process.cwd(), "corpus");
  const out = [];
  for (const f of readdirSync(dir)) {
    if (!statSync(join(dir, f)).isFile()) continue;
    try { out.push(...parseClaudeMd(join(dir, f), "project")); } catch { /* unreadable */ }
  }
  return out;
}

const rules = rulesDir === "corpus" ? corpusRules() : loadRules(rulesDir);
const cls = classifyRules(rules).filter((c) => "polarity" in c && (c as { polarity?: string }).polarity === "forbid");
/**
 * Only rules naming EXACTLY ONE command-shaped literal can block.
 *
 * A rule whose backticks hold both the banned thing and the recommended
 * alternative ("never commit browse/ ... use `git status` ... never
 * `git add -A`") gives no way to tell which literal is the prohibition, and
 * blocking on any of them refuses the safe one. Measured: that single
 * ambiguity accounted for 69 refusals of plain `git status`.
 */
const literal = (cls.filter((c) => c.kind === "deterministic") as Array<{ rule: { id: string; title: string }; patterns: string[] }>)
  .map((c) => ({ ...c, patterns: c.patterns.filter(literalIsCommandShaped) }))
  .filter((c) => c.patterns.length === 1);
const of = (k: string) => cls.filter((c) => c.kind === k) as never;

console.log(`Rules from ${rulesDir}: ${rules.length} total, ${cls.length} forbidding and reachable by the guard`);
console.log(`  literal-matching: ${literal.length}   structured: ${cls.length - literal.length}`);

const sessions = pinnedSessions(sessionCount);
console.log(`\nSessions (largest ${sessions.length}):`);
for (const s of sessions) console.log(`  ${s.replace(homedir(), "~")}`);

let calls = 0;
let blocked = 0;
let blockedLiteral = 0;
let blockedStructured = 0;
const reasons = new Map<string, { n: number; sample: string }>();

for (const path of sessions) {
  let events: TranscriptEvent[];
  try { events = readTranscriptFromFile(path); } catch { continue; }
  for (const event of events) {
    if (event.kind !== "tool_use") continue;
    const tool = event.toolName ?? "";
    const isBash = tool === "Bash" && typeof (event.input as { command?: unknown })?.command === "string";
    const isWrite = tool === "Write" || tool === "Edit" || tool === "NotebookEdit";
    if (!isBash && !isWrite) continue;
    calls += 1;

    const hits: string[] = [];
    const litHits: string[] = [];
    if (isBash) {
      const command = (event.input as { command: string }).command;
      for (const c of literal) {
        for (const p of c.patterns) {
          if (commandRunsLiteral(command, p)) { litHits.push(`Rule ${c.rule.id} "${c.rule.title.slice(0, 40)}" <- literal \`${p}\``); break; }
        }
      }
    }
    hits.push(...litHits);
    const before = hits.length;
    for (const r of [
      ...runCodeContentChecks(of("codeContent"), [event]),
      ...runFileLifecycleChecks(of("fileLifecycle"), [event]),
      ...runGitBranchPolicyChecks(of("gitBranchPolicy"), [event]),
    ]) {
      if (r.status === "FAIL") hits.push(`Rule ${r.ruleId} "${r.ruleTitle.slice(0, 40)}" <- ${r.evidence.slice(0, 80)}`);
    }

    if (litHits.length > 0) blockedLiteral += 1;
    if (hits.length > before) blockedStructured += 1;
    if (hits.length === 0) continue;
    blocked += 1;
    const sample = isBash
      ? (event.input as { command: string }).command.replace(/\s+/g, " ").slice(0, 150)
      : `${tool} on ${(event.input as { file_path?: string }).file_path}`;
    for (const h of hits) {
      const prev = reasons.get(h);
      reasons.set(h, { n: (prev?.n ?? 0) + 1, sample: prev?.sample ?? sample });
    }
  }
}

console.log(`\nTool calls replayed: ${calls}`);
console.log(`Would have been BLOCKED: ${blocked}  (${calls ? ((blocked / calls) * 100).toFixed(2) : "0"}%)`);
console.log(`  by a literal rule:    ${blockedLiteral}  (${calls ? ((blockedLiteral / calls) * 100).toFixed(2) : "0"}%)`);
console.log(`  by a structured rule: ${blockedStructured}  (${calls ? ((blockedStructured / calls) * 100).toFixed(2) : "0"}%)`);
if (reasons.size === 0) {
  console.log("\nNo refusals. Note what that does and does not mean: these sessions did not do the forbidden things, which is not evidence the guard would catch them if they had.");
} else {
  console.log(`\nEvery refusal, for reading by a person:`);
  for (const [why, { n, sample }] of [...reasons.entries()].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`\n  ${n}x  ${why}`);
    console.log(`      first: ${sample}`);
  }
}
