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
import { redact } from "./wrong.js";

/** One rule's fields as they appear in a `check --json` receipt (see generateJsonReport). */
interface ReceiptResult {
  ruleTitle?: unknown;
  status?: unknown;
  evidence?: unknown;
  notVisible?: unknown;
  needsHuman?: unknown;
}

const MAX_EVIDENCE = 160;

/** First line of evidence, redacted, collapsed and capped — never multi-line in a list item. */
function oneLineEvidence(raw: string): string {
  const first = redact(raw).split(/\r?\n/)[0].trim();
  if (!first) return "";
  const collapsed = first.replace(/\s+/g, " ");
  return collapsed.length > MAX_EVIDENCE ? collapsed.slice(0, MAX_EVIDENCE - 1) + "…" : collapsed;
}

function title(raw: unknown): string {
  return redact(String(raw ?? "")).replace(/\s+/g, " ").trim() || "(untitled rule)";
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

  const broken = results.filter((r) => r.status === "FAIL" && !r.notVisible);
  const followed = results.filter((r) => r.status === "PASS");
  const notVisible = results.filter((r) => r.status === "FAIL" && r.notVisible);
  // Everything else — UNCLEAR, judgment calls — is "can't tell".
  const cantTell = results.filter((r) => r.status !== "FAIL" && r.status !== "PASS");

  const s = receipt.summary ?? { total: results.length, pass: followed.length, fail: broken.length, unclear: cantTell.length };
  const headline = `**RuleReceipt** — ${broken.length} broken · ${followed.length} followed · ${cantTell.length} can't tell`;
  const ver = receipt.version ? ` _(rulereceipt ${receipt.version})_` : "";

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
    out.push(`${cantTell.length} rule${cantTell.length === 1 ? "" : "s"} can't be told from this session (judgment calls, or no evidence either way).`, "");
  }

  if (notVisible.length > 0) {
    out.push(`${notVisible.length} rule${notVisible.length === 1 ? "" : "s"} would have broken but weren't loaded into the session's context, so they aren't counted as broken.`, "");
  }

  out.push(
    "",
    `<sub>Checked locally from the session log; the transcript never leaves the machine. ${
      s.pass + s.fail + s.unclear >= 0 ? `${receipt.summary?.total ?? results.length} rules total.` : ""
    } Verify: \`rulereceipt verify-receipt\`.</sub>`,
  );

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
