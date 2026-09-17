/**
 * stonianua, #90542, 2026-09-16: "Curious whether marking obligation-clause
 * on a small sample collapses the 2.49% residue the way dropping
 * polarity-default collapsed 15.8% -> 7.6%."
 *
 * Two arms over the same corpus rules and the same real tool calls:
 *   A. unratified — every command-shaped literal in a forbidding rule may block
 *   B. ratified   — only the literal a person marked may block
 *
 * Arm B simulates the mark: the literal appearing closest after a forbidding
 * word, with nothing marked where no prohibition introduces one.
 *
 * IT DOES NOT ANSWER THE QUESTION, and the reason is the result worth
 * keeping. Arm B still refuses `npm run build` 115 times — the same rule,
 * the same recommended command, the same mistake the feature exists to
 * remove. The proxy marks what a prohibition sits near; a person marks what
 * a prohibition MEANS, and reading "just verify the build passes
 * (`npm run build`)" nobody would mark it.
 *
 * So the honest reading of 4.04% -> 2.27% is that a heuristic mark halves
 * the refusals and keeps the worst one. The remaining blocks on `git add -A`,
 * `git commit` and `git push` are genuine: those rules do ban them and those
 * commands did run.
 *
 * What would answer it is a person marking a sample by hand. That is the
 * same wall as the three-bucket taxonomy: the judgment the feature captures
 * is the judgment no automation here can stand in for. Published rather than
 * quietly dropped, because a proxy that reproduces the failure it is
 * measuring is worth exactly as much as a test that cannot fail.
 */
import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { readTranscriptFromFile } from "../src/parsers/transcriptParser.js";
import { parseClaudeMd } from "../src/parsers/readClaudeMd.js";
import { classifyRules } from "../src/checks/classify.js";
import { commandRunsLiteral, literalIsCommandShaped } from "../src/checks/proposedAction.js";
import type { TranscriptEvent } from "../src/types.js";

const FORBID_WORD = /\b(never|don't|do not|avoid|must not|no longer|forbidden|prohibited|banned)\b/gi;

/** Which literal would a reader mark as the ban? The one a prohibition introduces. */
function markedLiteral(text: string, literals: string[]): string | null {
  let best: { lit: string; gap: number } | null = null;
  for (const lit of literals) {
    const at = text.indexOf(lit);
    if (at < 0) continue;
    FORBID_WORD.lastIndex = 0;
    let nearest = -1;
    for (const m of text.matchAll(FORBID_WORD)) if (m.index! < at) nearest = m.index!;
    if (nearest < 0) continue;              // no prohibition introduces it -> unmarked
    const gap = at - nearest;
    if (gap > 120) continue;                // too far to be the same clause
    if (!best || gap < best.gap) best = { lit, gap };
  }
  return best?.lit ?? null;
}

const roots = readdirSync(homedir()).filter((d) => d.startsWith(".claude") && !d.includes("office"))
  .map((d) => join(homedir(), d, "projects")).filter((p) => existsSync(p));
const files: { path: string; size: number }[] = [];
for (const root of roots) for (const proj of readdirSync(root)) {
  let es: string[]; try { es = readdirSync(join(root, proj)); } catch { continue; }
  for (const f of es) if (f.endsWith(".jsonl")) try { files.push({ path: join(root, proj, f), size: statSync(join(root, proj, f)).size }); } catch { /* skip */ }
}
const sessions = files.sort((a, b) => b.size - a.size || a.path.localeCompare(b.path)).slice(0, 3).map((f) => f.path);

const CORPUS = join(process.cwd(), "corpus");
const rules = readdirSync(CORPUS).filter((f) => statSync(join(CORPUS, f)).isFile())
  .flatMap((f) => { try { return parseClaudeMd(join(CORPUS, f), "project"); } catch { return []; } });

const det = classifyRules(rules).filter((c) => c.kind === "deterministic" && (c as { polarity?: string }).polarity === "forbid") as Array<{ rule: { title: string; text: string }; patterns: string[] }>;

const armA = det.map((c) => ({ c, lits: c.patterns.filter(literalIsCommandShaped) })).filter((x) => x.lits.length > 0);
const armB = det.map((c) => {
  const lits = c.patterns.filter(literalIsCommandShaped);
  const m = markedLiteral(`${c.rule.title}\n${c.rule.text}`, lits);
  return { c, lits: m ? [m] : [] };
}).filter((x) => x.lits.length > 0);

console.log(`Forbidding rules with a command-shaped literal: ${armA.length}`);
console.log(`Of those, rules where a prohibition actually introduces one: ${armB.length}  (${((armB.length / armA.length) * 100).toFixed(1)}%)`);
console.log(`So ${armA.length - armB.length} rules become unable to block at all.\n`);

let calls = 0, blockedA = 0, blockedB = 0;
for (const p of sessions) {
  let ev: TranscriptEvent[]; try { ev = readTranscriptFromFile(p); } catch { continue; }
  for (const e of ev) {
    if (e.kind !== "tool_use" || e.toolName !== "Bash") continue;
    const cmd = (e.input as { command?: unknown })?.command;
    if (typeof cmd !== "string") continue;
    calls++;
    if (armA.some((x) => x.lits.some((l) => commandRunsLiteral(cmd, l)))) blockedA++;
    if (armB.some((x) => x.lits.some((l) => commandRunsLiteral(cmd, l)))) blockedB++;
  }
}
const pct = (n: number) => `${((n / calls) * 100).toFixed(2)}%`;
console.log(`Bash calls replayed: ${calls}`);
console.log(`  A  unratified (any command-shaped literal): ${blockedA}  ${pct(blockedA)}`);
console.log(`  B  ratified   (only the marked clause):     ${blockedB}  ${pct(blockedB)}`);
