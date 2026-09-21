/**
 * The CI side of RuleReceipt.
 *
 * The check itself needs the local Claude Code session transcript, which a CI
 * runner does not have. So CI does not re-run the check — it verifies a
 * RECEIPT the developer produced locally with `check --json` and committed:
 * that it is a real RuleReceipt receipt, a schema this tool understands, not
 * stale, and that nothing FAILED.
 *
 * Honest trust boundary: the receipt commits to the session via its sha256,
 * but CI has no session to re-hash, so CI is trusting the committed receipt.
 * A signed/attested receipt closes that gap and is the documented next step;
 * until then, "verify-receipt" means "this receipt is well-formed, current,
 * and passing", not "CI independently re-derived it from the session".
 */

export interface Receipt {
  tool: string;
  schema: number;
  version: string;
  generatedAt: string;
  session: { path: string | null; sha256: string | null };
  summary: { total: number; pass: number; fail: number; unclear: number };
  results: unknown[];
}

/** The receipt schema this tool understands. Bumped in generateJsonReport on any breaking shape change. */
export const KNOWN_SCHEMA = 1;

export interface VerifyReceiptOptions {
  /** Reject a receipt whose generatedAt is older than this many days. */
  maxAgeDays?: number;
}

export interface VerifyResult {
  ok: boolean;
  problems: string[];
  receipt?: Receipt;
}

/**
 * Structural validation only — is this a RuleReceipt receipt at all, with the
 * fields the verifier relies on. Returns a typed receipt or a reason.
 */
export function parseReceipt(text: string): { receipt?: Receipt; error?: string } {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    return { error: `not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (obj === null || typeof obj !== "object") return { error: "receipt is not a JSON object" };
  const o = obj as Record<string, unknown>;
  if (o.tool !== "rulereceipt") return { error: `not a rulereceipt receipt (tool=${JSON.stringify(o.tool)})` };
  if (typeof o.schema !== "number") return { error: "receipt has no numeric 'schema'" };
  if (typeof o.generatedAt !== "string") return { error: "receipt has no 'generatedAt' timestamp" };
  const s = o.summary as Record<string, unknown> | undefined;
  if (!s || typeof s.fail !== "number" || typeof s.pass !== "number" || typeof s.unclear !== "number") {
    return { error: "receipt has no valid 'summary' counts" };
  }
  return { receipt: o as unknown as Receipt };
}

/**
 * The CI gate. ok=false with a reason list means fail the build. UNCLEAR
 * never fails on its own — same rule as `check`'s exit code: a rule that
 * needs human judgment is not a violation.
 */
export function verifyReceipt(text: string, opts: VerifyReceiptOptions = {}): VerifyResult {
  const parsed = parseReceipt(text);
  if (parsed.error) return { ok: false, problems: [parsed.error] };
  const r = parsed.receipt as Receipt;
  const problems: string[] = [];

  if (r.schema > KNOWN_SCHEMA) {
    problems.push(`receipt schema ${r.schema} is newer than this tool understands (${KNOWN_SCHEMA}) — upgrade rulereceipt`);
  }
  if (r.summary.fail > 0) {
    problems.push(`${r.summary.fail} rule${r.summary.fail === 1 ? "" : "s"} FAILED in this receipt`);
  }
  if (opts.maxAgeDays !== undefined) {
    const ms = Date.now() - new Date(r.generatedAt).getTime();
    const days = ms / 86_400_000;
    if (!Number.isFinite(days)) {
      problems.push(`receipt generatedAt is not a valid date: ${r.generatedAt}`);
    } else if (days > opts.maxAgeDays) {
      problems.push(`receipt is ${Math.floor(days)} days old, older than the ${opts.maxAgeDays}-day limit`);
    }
  }

  return { ok: problems.length === 0, problems, receipt: r };
}
