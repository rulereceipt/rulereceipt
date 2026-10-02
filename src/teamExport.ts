import type { CheckResult } from "./types.js";
import { redact } from "./wrong.js";

/**
 * Team preview (LOCAL, free). Two halves:
 *
 *  - `buildTeamExport` turns one `check` result into a small, shareable JSON
 *    record: verdicts + the quoted evidence line, a project name (basename only,
 *    never the absolute local path), a dev name, a date and the tool version.
 *    NO transcript, no raw session, no absolute paths — a dev chooses to share
 *    this file, so it must carry only what a verdict already shows.
 *
 *  - `mergeTeamExports` + `renderTeamHtml` combine several devs' exported files
 *    into one HTML page: which rules were broken most, by whom, and a day-by-day
 *    trend. Everything is read from the files the devs chose to share; nothing is
 *    uploaded, there is no server and no account. It is labelled "team preview".
 *
 * This stays deliberately small. The hosted/paid team tier (a server, stored
 * history, SSO, billing, a cross-repo dashboard) is a separate thing; this is a
 * local merge of local exports.
 */

export const EXPORT_SCHEMA = 1;

export interface TeamExport {
  tool: "rulereceipt";
  kind: "export";
  schema: number;
  version: string;
  /** Who produced it — editable; from --dev, RULERECEIPT_DEV, or git user.name. */
  dev: string;
  /** Project basename only, never the absolute path. */
  project: string;
  /** ISO date (day precision is enough for a trend). */
  date: string;
  summary: { total: number; pass: number; fail: number; unclear: number };
  /** One entry per rule: the verdict and the quoted evidence. `notVisible` marks
   * a would-be break the rule wasn't in context for — never counted as broken. */
  rules: { title: string; source: string; status: CheckResult["status"]; evidence: string; notVisible?: boolean }[];
}

export function buildTeamExport(
  results: CheckResult[],
  project: string,
  dev: string,
  version: string,
  now = new Date(),
): TeamExport {
  const count = (s: CheckResult["status"]) => results.filter((r) => r.status === s).length;
  // A "rule not visible" FAIL is never counted as broken — same rule as the report.
  const fail = results.filter((r) => r.status === "FAIL" && !r.notVisible).length;
  return {
    tool: "rulereceipt",
    kind: "export",
    schema: EXPORT_SCHEMA,
    version,
    dev: dev.trim() || "unknown",
    project,
    date: now.toISOString().slice(0, 10),
    summary: { total: results.length, pass: count("PASS"), fail, unclear: count("UNCLEAR") },
    // Evidence is masked before it leaves: an export is shared, so obvious
    // secrets, the home path and emails are redacted (same patterns as `wrong`).
    rules: results.map((r) => ({ title: redact(r.ruleTitle), source: r.ruleSource, status: r.status, evidence: redact(r.evidence), ...(r.notVisible ? { notVisible: true } : {}) })),
  };
}

/** A tolerant parse of one export file's text; null if it is not a valid export. */
export function parseExport(text: string): TeamExport | null {
  try {
    const o = JSON.parse(text) as Partial<TeamExport>;
    if (o && o.tool === "rulereceipt" && o.kind === "export" && Array.isArray(o.rules)) return o as TeamExport;
  } catch {
    /* not an export */
  }
  return null;
}

export interface TeamMerge {
  devs: string[];
  exportsRead: number;
  /** Rules with at least one Broken verdict, most-broken first. */
  broken: { title: string; count: number; devs: string[] }[];
  totalBroken: number;
}

/**
 * Merge several devs' exports into a BASIC snapshot: rules broken most, by whom.
 * Public/free tier — deliberately a snapshot of the exports given, with NO trend
 * over time and NO stored history. Trends, history, cross-repo dashboards and
 * compliance exports are the private Team tier (see DECISIONS.md open-core rule)
 * and are never built into the public package.
 */
export function mergeTeamExports(exports: TeamExport[]): TeamMerge {
  const devs = [...new Set(exports.map((e) => e.dev))].sort();
  const byRule = new Map<string, { count: number; devs: Set<string> }>();
  let totalBroken = 0;
  for (const e of exports) {
    for (const r of e.rules) {
      if (r.status !== "FAIL" || r.notVisible) continue; // a not-visible break is not broken
      totalBroken++;
      const cur = byRule.get(r.title) ?? { count: 0, devs: new Set<string>() };
      cur.count++;
      cur.devs.add(e.dev);
      byRule.set(r.title, cur);
    }
  }
  const broken = [...byRule.entries()]
    .map(([title, v]) => ({ title, count: v.count, devs: [...v.devs].sort() }))
    .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title));
  return { devs, exportsRead: exports.length, broken, totalBroken };
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

/** A self-contained HTML team report — no external scripts, styles or fonts. */
export function renderTeamHtml(m: TeamMerge, now = new Date()): string {
  const rows = m.broken.length
    ? m.broken.map((b) => `<tr><td>${esc(b.title)}</td><td class="n">${b.count}</td><td>${b.devs.map(esc).join(", ")}</td></tr>`).join("\n")
    : `<tr><td colspan="3" class="muted">No proven breaks across these exports.</td></tr>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>RuleReceipt team preview</title><style>
:root{--fg:#111;--muted:#666;--line:#e2e2e2;--bg:#fff;--accent:#b44}
@media(prefers-color-scheme:dark){:root{--fg:#eee;--muted:#999;--line:#333;--bg:#141414;--accent:#e88}}
body{font:15px/1.5 -apple-system,system-ui,sans-serif;color:var(--fg);background:var(--bg);margin:0;padding:24px;max-width:820px;margin:0 auto}
h1{font-size:20px;margin:0 0 2px}.tag{display:inline-block;font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--accent);border:1px solid var(--accent);border-radius:3px;padding:1px 6px;vertical-align:middle;margin-left:8px}
.sub{color:var(--muted);margin:0 0 20px}
table{border-collapse:collapse;width:100%;margin:6px 0 24px}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.03em}td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
.muted{color:var(--muted)}.bar{display:flex;align-items:center;gap:8px;margin:3px 0}.bar .d{width:92px;color:var(--muted);font-size:13px}
.track{flex:1;background:var(--line);border-radius:3px;height:14px;overflow:hidden}.fill{display:block;height:100%;background:var(--accent)}.bar .n{width:28px;text-align:right;font-variant-numeric:tabular-nums}
footer{color:var(--muted);font-size:12px;margin-top:28px;border-top:1px solid var(--line);padding-top:12px}
</style></head><body>
<h1>RuleReceipt <span class="tag">team preview</span></h1>
<p class="sub">${m.exportsRead} export${m.exportsRead === 1 ? "" : "s"} from ${m.devs.length} dev${m.devs.length === 1 ? "" : "s"} · ${m.totalBroken} proven break${m.totalBroken === 1 ? "" : "s"} · generated ${esc(now.toISOString().slice(0, 16).replace("T", " "))}</p>
<h2 style="font-size:15px">Rules broken most</h2>
<table><thead><tr><th>Rule</th><th class="n">Breaks</th><th>By</th></tr></thead><tbody>
${rows}
</tbody></table>
<footer>A snapshot of the export files each dev chose to share, merged locally. Nothing was uploaded; there is no server or account. Verdicts are what RuleReceipt could prove from each session; it detects and reports, and does not make the model obey. Dev names come from the export files and can be edited there. Trends over time, history and cross-repo views are a separate paid tier, not this local snapshot.</footer>
</body></html>`;
}
