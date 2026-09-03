/** Per-format breakdown of the corpus, for publishing the methodology. */
import { readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { parseClaudeMd } from "../src/parsers/readClaudeMd.js";
import { classifyRule } from "../src/checks/classify.js";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    try { statSync(full).isDirectory() ? out.push(...walk(full)) : out.push(full); } catch {}
  }
  return out;
}
function format(f: string): string {
  const b = basename(f).toLowerCase();
  if (b.includes("claude.md") || b.includes("claude_md")) return "CLAUDE.md";
  if (b.includes("agents.md") || b.includes("agent.md")) return "AGENTS.md";
  if (b.includes("cursorrules") || b.includes("cursor")) return ".cursorrules";
  if (b.includes("copilot")) return "copilot-instructions.md";
  if (b.includes("windsurf")) return ".windsurfrules";
  if (b.includes("gemini")) return "GEMINI.md";
  return "other";
}
const files = walk("corpus");
const byFmt = new Map<string, {files:number; parsed:number; notRule:number; judgment:number; checkable:number}>();
let T = {files:0, parsed:0, notRule:0, judgment:0, checkable:0};
for (const f of files) {
  const fmt = format(f);
  const s = byFmt.get(fmt) ?? {files:0,parsed:0,notRule:0,judgment:0,checkable:0};
  s.files++; T.files++;
  for (const r of parseClaudeMd(f, "project")) {
    const k = classifyRule(r).kind;
    s.parsed++; T.parsed++;
    if (k === "notARule") { s.notRule++; T.notRule++; }
    else if (k === "judgment") { s.judgment++; T.judgment++; }
    else { s.checkable++; T.checkable++; }
  }
  byFmt.set(fmt, s);
}
const pc = (a:number,b:number) => b===0 ? "0.0" : ((a/b)*100).toFixed(1);
console.log(`TOTAL  files=${T.files} parsed=${T.parsed} notRule=${T.notRule} (${pc(T.notRule,T.parsed)}%) realRules=${T.parsed-T.notRule} checkable=${T.checkable} (${pc(T.checkable,T.parsed-T.notRule)}% of real) judgment=${T.judgment} (${pc(T.judgment,T.parsed-T.notRule)}% of real)`);
console.log("\nformat                    files  parsed  notARule%  checkable%(of real)");
for (const [fmt,s] of [...byFmt.entries()].sort((a,b)=>b[1].files-a[1].files)) {
  const real = s.parsed - s.notRule;
  console.log(`${fmt.padEnd(26)}${String(s.files).padStart(5)}${String(s.parsed).padStart(8)}${pc(s.notRule,s.parsed).padStart(10)}%${pc(s.checkable,real).padStart(13)}%`);
}
