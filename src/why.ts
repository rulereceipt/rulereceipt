import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { loadRules, describeRuleSources } from "./rules.js";
import { classifyRule } from "./checks/classify.js";
import { adviseRule } from "./checkability.js";
import { scanHistory } from "./historyReport.js";
import type { Rule } from "./types.js";

/**
 * `rulereceipt why "<rule text>"` — everything the tool already knows about ONE
 * rule, in one place: where it lives, whether the agent even loads it, whether a
 * command/path it names exists, whether it is mechanically checkable (and if
 * not, the smallest edit that would make it), and how it has done in the last 30
 * days. It answers the exact question people ask — "why isn't THIS rule
 * working?" — and it invents nothing: every line is combined from data the
 * engine already produces. Read-only; no verdict is created here.
 */

const CHECKABLE_KINDS = new Set([
  "gitBranchPolicy", "fileLifecycle", "codeContent", "approvalGate",
  "claimEvidence", "deterministic", "attribution", "emojiOutput", "ifEditThenTest",
]);

export interface WhyRule {
  id: string;
  title: string;
  source: "global" | "project";
  location: string;
  loaded: boolean;
  loadNote?: string;
  pathScoped?: string;
  checkable: boolean;
  kind: string;
  suggestion?: string;
  named?: { kind: "command" | "file"; name: string; exists: boolean };
  brokenCount: number;
  brokenDates: string[];
  sessionsScanned: number;
}

export interface WhyResult {
  query: string;
  matches: number;
  rule?: WhyRule;
  candidates?: { title: string; location: string }[];
}

/** Fuzzy-match a rule by the query appearing in its title/body, or the query being the title. */
export function findRules(rules: Rule[], query: string): Rule[] {
  // Normalize both sides to lowercase words separated by single spaces, so
  // punctuation the user won't type (commas, backticks, dashes) doesn't block a
  // match: "clean elegant maintainable" finds "clean, elegant, maintainable".
  const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const q = clean(query);
  if (q.length === 0) return [];
  const exact = rules.filter((r) => clean(r.title) === q);
  if (exact.length > 0) return exact;
  return rules.filter((r) => {
    const hay = clean(`${r.title} ${r.text}`);
    if (hay.includes(q)) return true;
    // Reverse direction (query IS roughly the title) only for a title long
    // enough to be distinctive — otherwise a 1-char heading like "A" matches
    // any query that happens to contain that letter.
    const title = clean(r.title);
    return title.length >= 6 && q.includes(title);
  });
}

/** A `npm run <script>` or a backtick file path the rule names, and whether it exists. */
function namedCommandOrPath(rule: Rule, cwd: string): WhyRule["named"] {
  const text = `${rule.title} ${rule.text}`;
  const script = text.match(/\b(?:npm|pnpm|yarn)\s+run\s+([\w:-]+)/);
  if (script) {
    let exists = false;
    try {
      const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf-8")) as { scripts?: Record<string, unknown> };
      exists = Boolean(pkg.scripts && script[1] in pkg.scripts);
    } catch {
      /* no package.json: report not found */
    }
    return { kind: "command", name: `${script[1]}`, exists };
  }
  const path = text.match(/`([^`\s]+\.[a-z0-9]{1,6})`/i);
  if (path && !path[1].includes("://")) {
    const p = isAbsolute(path[1]) ? path[1] : join(cwd, path[1]);
    return { kind: "file", name: path[1], exists: existsSync(p) };
  }
  return undefined;
}

/** Break counts per rule id+title, plus the total sessions scanned. Computed once. */
type HistLookup = { sessionsScanned: number; byRule: Map<string, { count: number; lastMs: number }> };

async function historyLookup(cwd: string, rules: Rule[]): Promise<HistLookup> {
  try {
    const hist = await scanHistory(cwd, rules, 30);
    const byRule = new Map<string, { count: number; lastMs: number }>();
    for (const b of hist.breaks) byRule.set(`${b.ruleId}\u0000${b.ruleTitle}`, { count: b.count, lastMs: b.lastMs });
    return { sessionsScanned: hist.sessionsScanned, byRule };
  } catch {
    return { sessionsScanned: 0, byRule: new Map() };
  }
}

/** Build the WhyRule facts for one rule, reusing an already-computed load graph and history. */
function ruleFacts(cwd: string, rule: Rule, graph: ReturnType<typeof describeRuleSources>, hist: HistLookup): WhyRule {
  const src = rule.sourcePath ? graph.find((e) => e.path === rule.sourcePath) : undefined;
  const cls = classifyRule(rule);
  const checkable = CHECKABLE_KINDS.has(cls.kind);
  const advice = checkable ? null : adviseRule(rule);
  const b = hist.byRule.get(`${rule.id}\u0000${rule.title}`);
  return {
    id: rule.id,
    title: rule.title,
    source: rule.source,
    location: locationOf(rule),
    loaded: src ? src.status === "loaded" : true,
    loadNote: src?.note,
    pathScoped: rule.paths ? rule.paths.join(", ") : undefined,
    checkable,
    kind: cls.kind,
    suggestion: advice?.suggestion,
    named: namedCommandOrPath(rule, cwd),
    brokenCount: b?.count ?? 0,
    brokenDates: b ? [new Date(b.lastMs).toISOString().slice(0, 10)] : [],
    sessionsScanned: hist.sessionsScanned,
  };
}

export async function explainRule(cwd: string, query: string): Promise<WhyResult> {
  const rules = loadRules(cwd);
  const matches = findRules(rules, query);
  if (matches.length === 0) return { query, matches: 0 };
  if (matches.length > 1) {
    return {
      query,
      matches: matches.length,
      candidates: matches.slice(0, 12).map((r) => ({ title: r.title, location: locationOf(r) })),
    };
  }
  const graph = describeRuleSources(cwd);
  const hist = await historyLookup(cwd, rules);
  return { query, matches: 1, rule: ruleFacts(cwd, matches[0], graph, hist) };
}

/** A "problem" rank so `why --all` can put the ones that need attention first. */
function problemRank(w: WhyRule): number {
  if (!w.loaded) return 0; // the agent never sees it
  if (w.named && !w.named.exists) return 1; // names a command/file that does not exist
  if (w.brokenCount > 0) return 2; // broken recently
  if (!w.checkable) return 3; // needs judgment
  return 4; // fine
}

export interface WhyAll {
  rules: WhyRule[];
  sessionsScanned: number;
}

/**
 * `why --all` — the same facts for every loaded rule, problems first (not loaded, then a
 * named command/file missing, then broken recently, then judgment-only, then the rest).
 * Read-only, facts only, no verdicts. Order within a rank is the rule's own order.
 */
export async function explainAll(cwd: string): Promise<WhyAll> {
  const rules = loadRules(cwd);
  const graph = describeRuleSources(cwd);
  const hist = await historyLookup(cwd, rules);
  const facts = rules.map((r) => ruleFacts(cwd, r, graph, hist));
  const ranked = facts
    .map((w, i) => ({ w, i }))
    .sort((a, b) => problemRank(a.w) - problemRank(b.w) || a.i - b.i)
    .map((x) => x.w);
  return { rules: ranked, sessionsScanned: hist.sessionsScanned };
}

/** The no-argument help: how to use `why`, plus every rule with its id, so people can pick. */
export function whyList(cwd: string): { id: string; title: string; location: string }[] {
  return loadRules(cwd).map((r) => ({ id: r.id, title: r.title, location: locationOf(r) }));
}

function locationOf(rule: Rule): string {
  if (!rule.sourcePath) return "unknown";
  const home = homedir();
  const p = rule.sourcePath.startsWith(home) ? `~${rule.sourcePath.slice(home.length)}` : rule.sourcePath;
  return rule.sourceLine ? `${p}:${rule.sourceLine}` : p;
}

export function renderWhy(r: WhyResult): string {
  if (r.matches === 0) return `No rule matched "${r.query}". Try a distinctive phrase from the rule, or run \`rulereceipt audit\` to list what loads.`;
  if (r.candidates) {
    const lines = r.candidates.map((c) => `  • ${c.title}   (${c.location})`);
    return `"${r.query}" matched ${r.matches} rules — narrow it down:\n${lines.join("\n")}`;
  }
  const w = r.rule!;
  const out: string[] = [];
  out.push(`Rule ${w.id} — ${w.title}`);
  out.push(`  at ${w.location}  (${w.source})`);
  out.push("");
  out.push(w.loaded ? `  ✓ loaded — the agent reads this file` : `  ✗ NOT loaded — ${w.loadNote ?? "the agent never sees this file"}`);
  if (w.pathScoped) out.push(`  • path-scoped: only loads when the session touches ${w.pathScoped}`);
  if (w.named) out.push(w.named.exists ? `  ✓ names a ${w.named.kind} that exists: ${w.named.name}` : `  ✗ names a ${w.named.kind} that does NOT exist here: ${w.named.name}`);
  out.push(w.checkable
    ? `  ✓ mechanically checkable (${w.kind}) — a session is judged against it with quoted evidence`
    : `  • needs your judgment${w.suggestion ? ` — ${w.suggestion}` : ` — no command or file to check it by; a human decides`}`);
  out.push("");
  if (w.brokenCount > 0) out.push(`  last 30 days: broken ${w.brokenCount}× (last: ${w.brokenDates[0]}) across ${w.sessionsScanned} session${w.sessionsScanned === 1 ? "" : "s"}`);
  else out.push(`  last 30 days: no proven break across ${w.sessionsScanned} session${w.sessionsScanned === 1 ? "" : "s"}`);
  return out.join("\n");
}

/** No-argument output: how to use `why`, then every rule with its id so you can pick one. */
export function renderWhyList(list: { id: string; title: string; location: string }[]): string {
  if (list.length === 0) return "No rules file found here. Run `rulereceipt init` to add one, then `rulereceipt why \"<rule>\"`.";
  const out = ['Explain one rule:  rulereceipt why "<some words from the rule>"', "Or all of them:    rulereceipt why --all", "", "Rules found:"];
  for (const r of list) out.push(`  ${r.id.padEnd(6)}  ${r.title.replace(/\s+/g, " ").slice(0, 72)}`);
  return out.join("\n");
}

/** One short line per rule for `why --all`, problems first. */
export function renderAllWhy(all: WhyAll): string {
  if (all.rules.length === 0) return "No rules file found here. Run `rulereceipt init` to add one.";
  const out: string[] = [];
  for (const w of all.rules) {
    let mark = "  ✓"; let note = w.checkable ? `checkable (${w.kind})` : "needs your judgment";
    if (!w.loaded) { mark = "  ✗"; note = `NOT loaded — ${w.loadNote ?? "the agent never sees this file"}`; }
    else if (w.named && !w.named.exists) { mark = "  ✗"; note = `names a ${w.named.kind} that does not exist: ${w.named.name}`; }
    else if (w.brokenCount > 0) { mark = "  ✗"; note = `broken ${w.brokenCount}× (last: ${w.brokenDates[0]})`; }
    out.push(`${mark} ${w.id.padEnd(6)} ${w.title.replace(/\s+/g, " ").slice(0, 60)}`);
    out.push(`         ${note}`);
  }
  out.push("");
  out.push(`across ${all.sessionsScanned} session${all.sessionsScanned === 1 ? "" : "s"} · run \`rulereceipt why "<rule>"\` for one rule in full`);
  return out.join("\n");
}
