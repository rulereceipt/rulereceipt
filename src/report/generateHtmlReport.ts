import { basename } from "node:path";
import type { CheckResult } from "../types.js";
import { computeTranscriptHash, type ReportMeta } from "./generateReport.js";

/**
 * A shareable, self-contained report — one HTML file with no external
 * requests, meant to be emailed, attached to a ticket, or printed to PDF.
 *
 * Why this exists: the terminal report can't leave the terminal. Every use
 * case this tool claims (a developer showing a manager, a contractor
 * evidencing compliance, a lead reviewing several developers' sessions)
 * ends with "send it to someone", and the honest previous answer was
 * "screenshot your terminal".
 *
 * Three properties this file must hold, in priority order:
 *
 * 1. SAFE. Rule titles and evidence are untrusted input — they come from a
 *    CLAUDE.md that may have arrived with a cloned repo, and evidence
 *    quotes real session content. The terminal path already strips ANSI
 *    escapes for exactly this reason (see generateReport.ts). The HTML path
 *    has a strictly worse failure mode: unescaped markup in a file the
 *    recipient opens in a browser is stored XSS, in a document whose entire
 *    purpose is to be trusted by someone who did not run the check. Every
 *    untrusted value goes through escapeHtml, with no exceptions, and the
 *    page contains no script and no inline event handlers at all.
 *
 * 2. SELF-CONTAINED. No CDN, no webfont, no external image. A compliance
 *    reader may open this offline, from an email attachment, years later.
 *
 * 3. HONEST. The report states what it cannot establish as prominently as
 *    what it can. A report that overstates its own authority is worse than
 *    no report for the audit use case it is meant to serve.
 */

export interface HtmlReportMeta extends ReportMeta {
  /** Directory the check ran in — shown so a reader knows what was audited. */
  projectPath: string;
  /** Injected rather than read from the clock, so output is deterministic in tests. */
  generatedAt: Date;
  /** Tool version, for reproducibility of a years-old report. */
  toolVersion: string;
}

/**
 * Escapes the five characters that can break out of either an HTML text
 * node or a quoted attribute value. Ampersand must be replaced first, or
 * the replacements themselves get double-escaped.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Same C0/C1 strip as the terminal report. Control characters have no
 * meaning in HTML, and stripping them here keeps the two report paths
 * showing identical text rather than subtly different content.
 */
function stripControlChars(value: string): string {
  return value.replace(/[\x00-\x09\x0B-\x1F\x7F-\x9F]/g, "");
}

/** Single choke point: nothing untrusted reaches the document except through this. */
function clean(value: string): string {
  return escapeHtml(stripControlChars(value));
}

const STATUS_LABEL: Record<CheckResult["status"], string> = {
  FAIL: "Not followed",
  PASS: "Followed",
  UNCLEAR: "Needs review",
};

/**
 * Failures first, deliberately. A report that opens with a wall of passes
 * and buries one failure at the bottom is a report designed to be skimmed
 * past — the opposite of what an audit document is for.
 */
const STATUS_ORDER: CheckResult["status"][] = ["FAIL", "UNCLEAR", "PASS"];

function ruleLabel(result: CheckResult, all: CheckResult[]): string {
  const collides = all.filter((other) => other.ruleId === result.ruleId).length > 1;
  return collides
    ? `Rule ${result.ruleId} (${result.ruleSource})`
    : `Rule ${result.ruleId}`;
}

function countBy(results: CheckResult[], status: CheckResult["status"]): number {
  return results.filter((r) => r.status === status).length;
}

function renderResultRow(result: CheckResult, all: CheckResult[]): string {
  const cls = result.status.toLowerCase();
  return `
        <article class="result result--${cls}">
          <div class="result__head">
            <span class="badge badge--${cls}">${clean(STATUS_LABEL[result.status])}</span>
            <span class="result__id">${clean(ruleLabel(result, all))}</span>
          </div>
          <h3 class="result__title">${clean(result.ruleTitle)}</h3>
          ${result.evidence ? `<p class="result__evidence">${clean(result.evidence)}</p>` : ""}
        </article>`;
}

function renderSection(status: CheckResult["status"], results: CheckResult[], all: CheckResult[]): string {
  const inSection = results.filter((r) => r.status === status);
  if (inSection.length === 0) return "";
  return `
      <section class="section">
        <h2 class="section__title">${clean(STATUS_LABEL[status])} <span class="section__count">${inSection.length}</span></h2>
        ${inSection.map((r) => renderResultRow(r, all)).join("")}
      </section>`;
}

/**
 * The headline verdict. Deliberately refuses to say "compliant" — this tool
 * checks a single session against rules it could mechanically evaluate, and
 * a reader who takes "compliant" from that has been misled by us, not by
 * the developer who sent it.
 */
function verdict(results: CheckResult[]): { text: string; cls: string } {
  const fail = countBy(results, "FAIL");
  const unclear = countBy(results, "UNCLEAR");
  if (fail > 0) {
    return { text: `${fail} rule${fail === 1 ? "" : "s"} not followed`, cls: "fail" };
  }
  if (unclear > 0) {
    return { text: `No rule violations found · ${unclear} need human review`, cls: "unclear" };
  }
  return { text: "No rule violations found", cls: "pass" };
}

export function generateHtmlReport(results: CheckResult[], meta: HtmlReportMeta): string {
  const hash = computeTranscriptHash(meta.sessionFilePath);
  const v = verdict(results);
  const project = basename(meta.projectPath) || meta.projectPath;
  const sessionName = meta.sessionFilePath ? basename(meta.sessionFilePath) : null;
  const generated = meta.generatedAt.toISOString();

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>RuleReceipt — ${clean(project)}</title>
<style>
  :root {
    --ink: #14161a; --muted: #5c636e; --line: #e2e5ea; --bg: #ffffff; --panel: #f7f8fa;
    --fail: #b4232c; --fail-bg: #fdf2f2; --pass: #1a7f4b; --pass-bg: #f1f9f4;
    --unclear: #8a6100; --unclear-bg: #fdf8ec;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 820px; margin: 0 auto; padding: 40px 24px 64px; }
  .head { border-bottom: 2px solid var(--ink); padding-bottom: 16px; margin-bottom: 24px; }
  .brand { font-size: 13px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; margin: 0 0 6px; }
  .head h1 { font-size: 26px; margin: 0 0 4px; letter-spacing: -.01em; }
  .head p { margin: 0; color: var(--muted); font-size: 14px; }
  .verdict { padding: 16px 18px; border-radius: 8px; margin-bottom: 24px; border: 1px solid; }
  .verdict--fail { background: var(--fail-bg); border-color: #f0c4c6; }
  .verdict--pass { background: var(--pass-bg); border-color: #bfe3cd; }
  .verdict--unclear { background: var(--unclear-bg); border-color: #ecdcb0; }
  .verdict strong { display: block; font-size: 19px; margin-bottom: 2px; }
  .verdict span { color: var(--muted); font-size: 14px; }
  .facts { width: 100%; border-collapse: collapse; margin-bottom: 32px; font-size: 14px; }
  .facts th, .facts td { text-align: left; padding: 9px 0; border-bottom: 1px solid var(--line); vertical-align: top; }
  .facts th { color: var(--muted); font-weight: 500; width: 190px; }
  .facts td { word-break: break-word; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; }
  .section { margin-bottom: 32px; }
  .section__title { font-size: 13px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; color: var(--muted); margin: 0 0 12px; }
  .section__count { color: var(--ink); }
  .result { border: 1px solid var(--line); border-left-width: 3px; border-radius: 6px; padding: 14px 16px; margin-bottom: 10px; }
  .result--fail { border-left-color: var(--fail); }
  .result--pass { border-left-color: var(--pass); }
  .result--unclear { border-left-color: var(--unclear); }
  .result__head { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
  .badge { font-size: 11px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; padding: 3px 8px; border-radius: 4px; }
  .badge--fail { background: var(--fail-bg); color: var(--fail); }
  .badge--pass { background: var(--pass-bg); color: var(--pass); }
  .badge--unclear { background: var(--unclear-bg); color: var(--unclear); }
  .result__id { font-size: 12px; color: var(--muted); }
  .result__title { font-size: 15px; margin: 0 0 6px; font-weight: 600; }
  .result__evidence { margin: 0; font-size: 14px; color: var(--muted); white-space: pre-wrap; }
  .note { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 16px 18px; font-size: 13.5px; color: var(--muted); }
  .note h2 { font-size: 13px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; color: var(--ink); margin: 0 0 10px; }
  .note ul { margin: 0 0 12px; padding-left: 18px; }
  .note li { margin-bottom: 5px; }
  .note p:last-child { margin-bottom: 0; }
  @media print {
    body { font-size: 12pt; }
    .wrap { max-width: none; padding: 0; }
    .result, .note, .verdict { break-inside: avoid; }
  }
  @media (max-width: 560px) {
    .facts th { width: auto; display: block; padding-bottom: 0; border: 0; }
    .facts td { display: block; padding-top: 2px; }
  }
</style>
</head>
<body>
<div class="wrap">

  <header class="head">
    <p class="brand">RuleReceipt</p>
    <h1>Agent rule check — ${clean(project)}</h1>
    <p>What the AI coding agent actually did in this session, checked against the project's written rules.</p>
  </header>

  <div class="verdict verdict--${v.cls}">
    <strong>${clean(v.text)}</strong>
    <span>${countBy(results, "PASS")} followed · ${countBy(results, "FAIL")} not followed · ${countBy(results, "UNCLEAR")} need review · ${results.length} rules checked</span>
  </div>

  <table class="facts">
    <tr><th>Project</th><td><code>${clean(meta.projectPath)}</code></td></tr>
    <tr><th>Session file</th><td>${sessionName ? `<code>${clean(sessionName)}</code>` : "<em>none — sample data</em>"}</td></tr>
    <tr><th>Session fingerprint</th><td>${hash ? `<code>sha256:${clean(hash)}</code>` : "<em>not applicable</em>"}</td></tr>
    <tr><th>Generated</th><td><code>${clean(generated)}</code></td></tr>
    <tr><th>Tool version</th><td><code>rulereceipt ${clean(meta.toolVersion)}</code></td></tr>
  </table>

${STATUS_ORDER.map((s) => renderSection(s, results, results)).join("")}

  <div class="note">
    <h2>How to read this report</h2>
    <ul>
      <li><strong>Followed</strong> — a specific action in the session satisfies the rule, or the forbidden action never occurred.</li>
      <li><strong>Not followed</strong> — a real action in the session contradicts the rule. The evidence quotes it.</li>
      <li><strong>Needs review</strong> — this rule can't be settled by looking at what commands ran. It is not a pass and not a failure; a person has to read the session and decide.</li>
    </ul>
    <h2>What this report does not establish</h2>
    <ul>
      <li>It covers <strong>one session</strong> in one project, not a person's overall work.</li>
      <li>It is <strong>not a compliance certification</strong>. It reports what a mechanical check could and could not determine.</li>
      <li>Rules requiring judgment are reported as "needs review" rather than guessed at. A large number of them means most of the rules in this project need a human, not that anything went wrong.</li>
      <li>A "followed" result means no contradicting action was found in this session — not that the rule can never be broken elsewhere.</li>
    </ul>
    <h2>Verifying this report</h2>
    ${
      hash
        ? `<p>The session fingerprint above is the SHA-256 of the raw session file. Anyone holding that file can confirm this report describes it, unaltered:</p>
    <p><code>rulereceipt verify &lt;session-file&gt; sha256:${clean(hash.slice(0, 16))}</code></p>
    <p>A changed session file produces a different fingerprint, so an edited session cannot be passed off as this one.</p>`
        : `<p>This report was generated from sample data and has no session fingerprint, so there is nothing to verify against.</p>`
    }
  </div>

</div>
</body>
</html>
`;
}
