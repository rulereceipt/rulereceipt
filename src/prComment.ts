/**
 * Render a committed receipt (from `check --json`) as a PR-comment markdown block.
 *
 * DISPLAY ONLY. This runs no check and makes no verdict — it reads the verdicts
 * already in the receipt and formats them for a pull-request comment: each rule,
 * its status, and one quoted evidence line, broken-first (PJ's team-lead ask).
 *
 * It takes a receipt, never a session: the raw transcript never leaves the
 * machine, and a receipt carries only a sha256 of it, not its contents. Evidence
 * and rule titles are redacted with the same masking the shared export uses,
 * because a PR comment is public — a quoted line must not leak a secret, a home
 * path or an email into a pull request.
 */

import type { Receipt } from "./receipt.js";
import type { CheckResult } from "./types.js";
import { type Bucket, bucketOf } from "./report/buckets.js";
import { redact } from "./wrong.js";

/** One rule's fields as they appear in a `check --json` receipt (see generateJsonReport). */
interface ReceiptResult {
  ruleTitle?: unknown;
  status?: unknown;
  outcome?: unknown;
  evidence?: unknown;
  notVisible?: unknown;
  needsHuman?: unknown;
}

const MAX_EVIDENCE = 160;

/**
 * Neutralise an untrusted string for safe INLINE rendering in a public PR
 * comment (rule titles, the tool version). A fork PR controls the receipt and
 * the CLAUDE.md it was checked against, and this text is posted by the repo's
 * token, so it must not be able to:
 *   - inject raw HTML or break out of the <details> fold  -> escape & < >
 *   - notify a third party with an @mention               -> @ becomes &#64;
 *   - forge an issue/PR cross-reference (#123)            -> # becomes &#35;
 *   - disguise a link as safe text ([text](url))          -> [ ] become entities
 *
 * Each replacement renders as the LITERAL glyph on GitHub (so "@ravikiran" is
 * still read as "@ravikiran") but carries no markdown or autolink meaning,
 * because the autolinker and HTML sanitiser see an entity, not the trigger
 * character. Ampersand is escaped first so the introduced entities are not
 * themselves double-escaped. Evidence is NOT run through this — it is wrapped in
 * a code span, inside which every one of these is already inert.
 */
function neutralizeMarkdown(value: string): string {
  // Order matters: the entities we introduce contain '&' and '#', so those
  // replacement steps must run BEFORE the '@'/'['/']' steps, or a '#' inside a
  // freshly-introduced "&#64;" would itself be re-encoded into "&&#35;64;".
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/#/g, "&#35;")
    .replace(/@/g, "&#64;")
    .replace(/\[/g, "&#91;")
    .replace(/\]/g, "&#93;");
}

/** First line of evidence, redacted, collapsed and capped — never multi-line in a list item. */
function oneLineEvidence(raw: string): string {
  const first = redact(raw).split(/\r?\n/)[0].trim();
  if (!first) return "";
  const collapsed = first.replace(/\s+/g, " ");
  return collapsed.length > MAX_EVIDENCE ? collapsed.slice(0, MAX_EVIDENCE - 1) + "…" : collapsed;
}

function title(raw: unknown): string {
  const t = redact(String(raw ?? "")).replace(/\s+/g, " ").trim();
  return t ? neutralizeMarkdown(t) : "(untitled rule)";
}

function item(r: ReceiptResult, marker: string): string {
  const ev = typeof r.evidence === "string" ? oneLineEvidence(r.evidence) : "";
  const base = `- ${marker} ${title(r.ruleTitle)}`;
  return ev ? `${base} — \`${ev.replace(/`/g, "ʼ")}\`` : base;
}

/**
 * Build the markdown. `broken` counts broken-AND-visible only (the same rule as
 * the summary everywhere else); a would-be break the rule wasn't in context for
 * is listed separately, never as broken.
 */
export function renderPrComment(receipt: Receipt): string {
  const results = (Array.isArray(receipt.results) ? receipt.results : []) as ReceiptResult[];

  // Count through the ONE shared classifier (buckets.ts) so this surface agrees
  // with the terminal, HTML, timeline and --json on followed / not-followed /
  // not-visible / can't-tell (enforced by the cross-surface parity gate). A
  // judgment call is NOT "can't tell" — the tool never had a mechanical answer —
  // so it gets its own line, same split the terminal makes.
  const bag = (b: Bucket) => results.filter((r) => bucketOf(r as unknown as CheckResult) === b);
  const broken = bag("FAIL");
  const followed = bag("PASS");
  const notVisible = bag("RULE_NOT_VISIBLE");
  const cantTell = bag("UNCLEAR_EVIDENCE");
  const needsJudgment = bag("UNCLEAR_JUDGMENT");

  const s = receipt.summary ?? { total: results.length, pass: followed.length, fail: broken.length, unclear: cantTell.length };
  const headline = `**RuleReceipt** — ${broken.length} broken · ${followed.length} followed · ${cantTell.length} can't tell`;
  // version is untrusted (it comes from the committed receipt) and public here.
  const ver = receipt.version ? ` _(rulereceipt ${neutralizeMarkdown(String(receipt.version))})_` : "";

  const out: string[] = [headline + ver, ""];

  if (broken.length > 0) {
    out.push(`**Broken (${broken.length})**`, ...broken.map((r) => item(r, "❌")), "");
  } else {
    out.push("No rules were broken in this session.", "");
  }

  if (followed.length > 0) {
    out.push(`<details><summary>Followed (${followed.length})</summary>`, "", ...followed.map((r) => item(r, "✅")), "", "</details>", "");
  }

  if (cantTell.length > 0) {
    out.push(`${cantTell.length} rule${cantTell.length === 1 ? "" : "s"} can't be told from this session (the tool looked, the evidence was ambiguous).`, "");
  }

  if (needsJudgment.length > 0) {
    out.push(`${needsJudgment.length} rule${needsJudgment.length === 1 ? "" : "s"} need a human's judgment (never a mechanical question).`, "");
  }

  if (notVisible.length > 0) {
    out.push(`${notVisible.length} rule${notVisible.length === 1 ? "" : "s"} would have broken but weren't loaded into the session's context, so they aren't counted as broken.`, "");
  }

  // total is untrusted (receipt JSON) — coerce to a non-negative integer so a
  // string like "</sub>@everyone" can never reach the public comment.
  const rawTotal = receipt.summary?.total ?? results.length;
  const total = Number.isFinite(Number(rawTotal)) ? Math.max(0, Math.trunc(Number(rawTotal))) : results.length;
  out.push(
    "",
    `<sub>Checked locally from the session log; the transcript never leaves the machine. ${
      s.pass + s.fail + s.unclear >= 0 ? `${total} rules total.` : ""
    } Verify: \`rulereceipt verify-receipt\`.</sub>`,
  );

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
