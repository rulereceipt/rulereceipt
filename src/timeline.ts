/**
 * `rulereceipt check --timeline` — a self-contained HTML view that lays the
 * session's EXISTING verdicts out along the session itself.
 *
 * DISPLAY ONLY. This runs no check and reaches no new verdict. It takes the
 * results `check` already computed (after the visibility pass) and the raw
 * transcript `check` already read, and answers one question the flat report
 * cannot: WHERE in the session each thing happened, and in what order. A lead
 * skimming "3 broken" still has to guess whether the break came before or after
 * the user corrected course, or whether a compaction dropped the rules partway
 * through. The timeline shows it.
 *
 * It reuses the two pieces that already know the raw transcript:
 *   - `applyVisibility` — a broken-but-not-visible rule is never shown as broken
 *     here either, so the timeline agrees with the report, the exit code and the
 *     export (one door).
 *   - `evidenceLineIndex` / `isCompactionLine` (breakContext) — the same locator
 *     the "why it broke" context uses, so a verdict sits at the same place both
 *     features would point to.
 *
 * A verdict whose evidence cannot be located in the log (a judgment call with no
 * quotable moment, or evidence with no distinctive fragment) is NOT guessed onto
 * the timeline — it is listed separately as "not placed", honestly. The position
 * is where the evidence TEXT appears in the raw log, not a wall-clock timestamp;
 * the page says so.
 *
 * Safety: rule titles and evidence are untrusted input (a cloned CLAUDE.md,
 * quoted session content), and this file is meant to be opened in a browser by
 * someone who did not run the check — the same stored-XSS surface as the
 * shareable HTML report. Every untrusted value goes through `clean`, the page
 * carries no script and no external request. Home paths are redacted for display
 * the same way the report does it; nothing else is auto-redacted (the CLI prints
 * the verbatim-evidence warning at write time).
 */

import { homedir } from "node:os";
import type { CheckResult } from "./types.js";
import type { ShadowFinding } from "./checks/shadowSignals.js";
import { applyVisibility } from "./visibility.js";
import { evidenceLineIndex, isCompactionLine } from "./breakContext.js";

export type TimelineLane = "broken" | "not-visible" | "followed" | "needs-judgment" | "cant-tell";

export interface TimelineVerdict {
  lane: TimelineLane;
  ruleId: string;
  ruleTitle: string;
  ruleSource: "global" | "project";
  /** Raw evidence; the renderer redacts/escapes it. Empty when there is none. */
  evidence: string;
  /** 0-based transcript line where the evidence last appears, or -1 if unplaceable. */
  line: number;
  /** Present only for the not-visible lane. */
  notVisibleReason?: "not-in-context" | "stale-after-compaction";
  notVisibleFix?: string;
}

export interface TimelineMarker {
  kind: "compaction";
  line: number;
}

export interface TimelineCounts {
  broken: number;
  notVisible: number;
  followed: number;
  needsJudgment: number;
  cantTell: number;
}

export interface SessionTimeline {
  /** Verdicts with a locatable position, earliest first. */
  placed: TimelineVerdict[];
  /** Verdicts with no locatable position (judgment calls, evidence-less). */
  unplaced: TimelineVerdict[];
  /** Compaction points, in session order. */
  markers: TimelineMarker[];
  counts: TimelineCounts;
}

export interface TimelineMeta {
  /** Directory the check ran in. */
  projectPath: string;
  /** The session file's basename, or null for sample data. */
  sessionName: string | null;
  /** sha256 of the raw session file, or null. */
  sessionFingerprint: string | null;
  /** Injected so output is deterministic in tests. */
  generatedAt: Date;
  toolVersion: string;
  /** True when only a prefix of a large session was read (positions cover that prefix only). */
  truncated?: boolean;
}

function laneOf(r: CheckResult): TimelineLane {
  if (r.status === "FAIL") return r.notVisible ? "not-visible" : "broken";
  if (r.status === "PASS") return "followed";
  return r.needsHuman ? "needs-judgment" : "cant-tell";
}

function toVerdict(r: CheckResult, lines: string[]): TimelineVerdict {
  const evidence = typeof r.evidence === "string" ? r.evidence : "";
  return {
    lane: laneOf(r),
    ruleId: r.ruleId,
    ruleTitle: r.ruleTitle,
    ruleSource: r.ruleSource,
    evidence,
    line: evidence ? evidenceLineIndex(lines, evidence) : -1,
    notVisibleReason: r.notVisible?.reason,
    notVisibleFix: r.notVisible?.fix,
  };
}

/**
 * Build the timeline from existing verdicts + the raw transcript. Visibility is
 * re-applied (idempotent — it skips results already marked), so a caller that
 * forgot cannot make the timeline show a not-visible rule as broken.
 */
export function buildTimeline(results: CheckResult[], transcriptText: string): SessionTimeline {
  const visible = applyVisibility(results, transcriptText);
  const lines = transcriptText.split(/\r?\n/);
  const verdicts = visible.map((r) => toVerdict(r, lines));

  const placed = verdicts.filter((v) => v.line >= 0).sort((a, b) => a.line - b.line);
  const unplaced = verdicts.filter((v) => v.line < 0);

  const markers: TimelineMarker[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (isCompactionLine(lines[i])) markers.push({ kind: "compaction", line: i });
  }

  const counts: TimelineCounts = {
    broken: verdicts.filter((v) => v.lane === "broken").length,
    notVisible: verdicts.filter((v) => v.lane === "not-visible").length,
    followed: verdicts.filter((v) => v.lane === "followed").length,
    needsJudgment: verdicts.filter((v) => v.lane === "needs-judgment").length,
    cantTell: verdicts.filter((v) => v.lane === "cant-tell").length,
  };

  return { placed, unplaced, markers, counts };
}

// --- rendering -------------------------------------------------------------

/** Escapes the five characters that break an HTML text node or quoted attribute. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Strip C0/C1 control chars — same as the terminal and HTML report paths. */
function stripControlChars(value: string): string {
  return value.replace(/[\x00-\x09\x0B-\x1F\x7F-\x9F]/g, "");
}

/** Display formatting only: replace the home directory with `~`. Protects nothing. */
function redactHome(value: string): string {
  const home = homedir();
  if (!home || home === "/" || home.length < 4) return value;
  return value.split(home).join("~");
}

/** Single choke point: nothing untrusted reaches the document except through this. */
function clean(value: string): string {
  return escapeHtml(stripControlChars(redactHome(value)));
}

const LANE_LABEL: Record<TimelineLane, string> = {
  broken: "Broken",
  "not-visible": "Rule not visible",
  followed: "Followed",
  "needs-judgment": "Needs your judgment",
  "cant-tell": "Couldn't tell",
};

/** One line of evidence, redacted + collapsed, for the compact timeline node. */
function oneLineEvidence(raw: string): string {
  const first = redactHome(raw).split(/\r?\n/)[0].replace(/\s+/g, " ").trim();
  return first.length > 200 ? first.slice(0, 199) + "…" : first;
}

function renderNode(v: TimelineVerdict): string {
  const ev = v.evidence ? `<p class="node__ev">${escapeHtml(stripControlChars(oneLineEvidence(v.evidence)))}</p>` : "";
  const fix =
    v.lane === "not-visible" && v.notVisibleFix
      ? `<p class="node__fix">${clean(v.notVisibleFix)}</p>`
      : "";
  return `
      <li class="node node--${v.lane}">
        <span class="dot" aria-hidden="true"></span>
        <div class="node__body">
          <span class="badge badge--${v.lane}">${clean(LANE_LABEL[v.lane])}</span>
          <span class="node__src">${clean(v.ruleSource)}</span>
          <h3 class="node__title">${clean(v.ruleTitle)}</h3>
          ${ev}
          ${fix}
        </div>
      </li>`;
}

function renderMarker(): string {
  return `
      <li class="node node--compaction">
        <span class="dot" aria-hidden="true"></span>
        <div class="node__body">
          <span class="badge badge--compaction">Context compacted</span>
          <p class="node__ev">The session was summarized here. A rule loaded before this point may have dropped out of context after it.</p>
        </div>
      </li>`;
}

/** Placed verdicts and compaction markers, merged into one stream by position. */
function renderStream(t: SessionTimeline): string {
  const stream: { line: number; order: number; html: string }[] = [];
  // Markers sort before a verdict on the same line: the compaction happened,
  // then the next action was judged.
  t.markers.forEach((m) => stream.push({ line: m.line, order: 0, html: renderMarker() }));
  t.placed.forEach((v, i) => stream.push({ line: v.line, order: i + 1, html: renderNode(v) }));
  stream.sort((a, b) => a.line - b.line || a.order - b.order);
  if (stream.length === 0) {
    return `<li class="node node--empty"><div class="node__body"><p class="node__ev">No verdict could be placed at a moment in this session.</p></div></li>`;
  }
  return stream.map((s) => s.html).join("");
}

/**
 * The shadow signals, rendered as advisory — NOT verdicts, same contract as the
 * shareable HTML report. These are contradictions the transcript shows that are
 * not counted in any of the lane totals above and have no effect on the result
 * or exit code. The detector (detectShadowSignals) is reused verbatim; nothing is
 * recomputed. `edited-rule-not-loaded` is already a couldn't-tell ("may never have
 * seen this rule"), never a flat "not loaded" — this renders its text verbatim.
 */
function renderShadowAdvisory(findings: ShadowFinding[]): string {
  if (findings.length === 0) return "";
  const items = findings
    .map(
      (f) =>
        `<li class="advisory__item"><span class="advisory__sig">${clean(f.signal)}</span> ${clean(f.evidence)}</li>`
    )
    .join("");
  return `
  <section class="advisory">
    <h2 class="section__title">Advisory — not a verdict <span class="section__count">${findings.length}</span></h2>
    <p class="section__note">Contradictions the transcript shows that are <strong>not</strong> verdicts: they are not counted among the lane totals above, and they do not change the result or the exit code. Their false-accusation rate is still being measured. Where an agent&#39;s transcript does not record whether a rule was loaded, these say &quot;may never have seen&quot; — a couldn&#39;t-tell, never a flat &quot;not loaded&quot;.</p>
    <ul class="advisory__list">${items}</ul>
  </section>`;
}

function renderUnplaced(t: SessionTimeline): string {
  if (t.unplaced.length === 0) return "";
  return `
  <section class="unplaced">
    <h2 class="section__title">Not placed on the timeline <span class="section__count">${t.unplaced.length}</span></h2>
    <p class="section__note">These verdicts have no single moment to point at in the session log — a judgment call, or evidence with nothing distinctive to locate. They are real verdicts; they just can't be positioned.</p>
    <ul class="list">${t.unplaced.map((v) => renderNode(v)).join("")}</ul>
  </section>`;
}

export function renderTimelineHtml(t: SessionTimeline, meta: TimelineMeta, shadowFindings: ShadowFinding[] = []): string {
  const c = t.counts;
  const headline =
    c.broken > 0 ? `${c.broken} rule${c.broken === 1 ? "" : "s"} broken` : "No rules broken";
  const headCls = c.broken > 0 ? "fail" : "pass";
  const sub = [
    `${c.followed} followed`,
    `${c.broken} broken`,
    `${c.cantTell} couldn't tell`,
    `${c.needsJudgment} need your judgment`,
    ...(c.notVisible > 0 ? [`${c.notVisible} not visible`] : []),
  ].join(" · ");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>RuleReceipt timeline — ${clean(meta.sessionName ?? "session")}</title>
<style>
  :root {
    --ink: #14161a; --muted: #5c636e; --line: #e2e5ea; --bg: #ffffff; --panel: #f7f8fa;
    --fail: #b4232c; --pass: #1a7f4b; --unclear: #8a6100; --judgment: #4a4e55;
    --notvis: #5b4bb4; --compact: #0b6b7a; --rail: #d7dbe2;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --ink: #e6edf3; --muted: #9aa4b2; --line: #2a2f37; --bg: #0b0d10; --panel: #14171c;
      --fail: #ff7b72; --pass: #3fb950; --unclear: #d6a635; --judgment: #9aa0a8;
      --notvis: #a99bff; --compact: #46c6d8; --rail: #2a2f37;
    }
  }
  :root[data-theme="dark"] {
    --ink: #e6edf3; --muted: #9aa4b2; --line: #2a2f37; --bg: #0b0d10; --panel: #14171c;
    --fail: #ff7b72; --pass: #3fb950; --unclear: #d6a635; --judgment: #9aa0a8;
    --notvis: #a99bff; --compact: #46c6d8; --rail: #2a2f37;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink);
    font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased; }
  .wrap { max-width: 820px; margin: 0 auto; padding: 40px 24px 64px; }
  .head { border-bottom: 2px solid var(--ink); padding-bottom: 16px; margin-bottom: 20px; }
  .brand { font-size: 13px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; margin: 0 0 6px; }
  .head h1 { font-size: 24px; margin: 0 0 4px; letter-spacing: -.01em; }
  .head h1.fail { color: var(--fail); }
  .head h1.pass { color: var(--pass); }
  .head p { margin: 0; color: var(--muted); font-size: 14px; }
  .facts { width: 100%; border-collapse: collapse; margin: 18px 0 26px; font-size: 13px; }
  .facts th, .facts td { text-align: left; padding: 7px 0; border-bottom: 1px solid var(--line); vertical-align: top; }
  .facts th { color: var(--muted); font-weight: 500; width: 170px; }
  .facts td { word-break: break-word; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; }
  .section__title { font-size: 13px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; color: var(--muted); margin: 28px 0 8px; }
  .section__count { color: var(--ink); }
  .section__note { font-size: 13px; color: var(--muted); margin: 0 0 12px; }
  .list { list-style: none; margin: 0; padding: 0; position: relative; }
  .list::before { content: ""; position: absolute; left: 6px; top: 4px; bottom: 4px; width: 2px; background: var(--rail); }
  .node { position: relative; padding: 0 0 16px 30px; }
  .dot { position: absolute; left: 0; top: 4px; width: 14px; height: 14px; border-radius: 50%; background: var(--muted); border: 3px solid var(--bg); }
  .node--broken .dot { background: var(--fail); }
  .node--followed .dot { background: var(--pass); }
  .node--cant-tell .dot { background: var(--unclear); }
  .node--needs-judgment .dot { background: var(--judgment); }
  .node--not-visible .dot { background: var(--notvis); }
  .node--compaction .dot { background: var(--compact); }
  .node__body { }
  .badge { display: inline-block; font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; padding: 2px 7px; border-radius: 4px; border: 1px solid var(--line); color: var(--muted); }
  .badge--broken { color: var(--fail); border-color: var(--fail); }
  .badge--followed { color: var(--pass); border-color: var(--pass); }
  .badge--cant-tell { color: var(--unclear); border-color: var(--unclear); }
  .badge--needs-judgment { color: var(--judgment); }
  .badge--not-visible { color: var(--notvis); border-color: var(--notvis); }
  .badge--compaction { color: var(--compact); border-color: var(--compact); }
  .node__src { font-size: 11px; color: var(--muted); margin-left: 8px; }
  .node__title { font-size: 15px; margin: 6px 0 4px; font-weight: 600; }
  .node__ev { margin: 0; font-size: 13.5px; color: var(--muted); white-space: pre-wrap; word-break: break-word; }
  .node__fix { margin: 6px 0 0; font-size: 13px; color: var(--notvis); }
  .note { margin-top: 32px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 16px 18px; font-size: 13px; color: var(--muted); }
  .note h2 { font-size: 12px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; color: var(--ink); margin: 0 0 8px; }
  .note ul { margin: 0 0 10px; padding-left: 18px; }
  .note li { margin-bottom: 4px; }
  .advisory { margin-top: 28px; }
  .advisory__list { list-style: none; margin: 0; padding: 0; }
  .advisory__item { border: 1px solid var(--line); border-left: 3px solid var(--unclear); border-radius: 6px; padding: 12px 14px; margin-bottom: 10px; font-size: 13.5px; color: var(--muted); word-break: break-word; }
  .advisory__sig { display: inline-block; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; color: var(--ink); background: var(--panel); padding: 1px 6px; border-radius: 4px; margin-right: 6px; }
  @media (max-width: 560px) { .facts th { width: auto; display: block; padding-bottom: 0; border: 0; } .facts td { display: block; padding-top: 2px; } }
</style>
</head>
<body>
<div class="wrap">
  <header class="head">
    <p class="brand">RuleReceipt · session timeline</p>
    <h1 class="${headCls}">${clean(headline)}</h1>
    <p>${clean(sub)}</p>
  </header>

  <table class="facts">
    <tr><th>Project</th><td><code>${clean(meta.projectPath)}</code></td></tr>
    <tr><th>Session file</th><td>${meta.sessionName ? `<code>${clean(meta.sessionName)}</code>` : "<em>none — sample data</em>"}</td></tr>
    <tr><th>Session fingerprint</th><td>${meta.sessionFingerprint ? `<code>sha256:${clean(meta.sessionFingerprint)}</code>` : "<em>not applicable</em>"}</td></tr>
    <tr><th>Generated</th><td><code>${clean(meta.generatedAt.toISOString())}</code></td></tr>
    <tr><th>Tool version</th><td><code>rulereceipt ${clean(meta.toolVersion)}</code></td></tr>
  </table>

  ${meta.truncated ? `<p class="section__note">This was a large session read only in part, so the timeline covers the portion that was read.</p>` : ""}

  <h2 class="section__title">In session order <span class="section__count">${t.placed.length}</span></h2>
  <ul class="list">${renderStream(t)}</ul>

  ${renderUnplaced(t)}
  ${renderShadowAdvisory(shadowFindings)}

  <div class="note">
    <h2>How to read this</h2>
    <ul>
      <li>Each verdict sits where its evidence appears in the session log — the order of events, not a clock time.</li>
      <li>A <strong>Rule not visible</strong> node is a would-be break the agent's context never held the rule for; it is not counted as broken.</li>
      <li><strong>Context compacted</strong> marks where the session was summarized — rules loaded earlier can drop out after it.</li>
      <li>This is one session, read locally. The transcript never left this machine; nothing here is a compliance certification.</li>
    </ul>
  </div>
</div>
</body>
</html>
`;
}
