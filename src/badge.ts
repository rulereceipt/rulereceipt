/**
 * A shields.io "endpoint" badge, derived from a receipt.
 *
 * The user commits the receipt (from `check --json`), runs `rulereceipt badge
 * <receipt>` to emit this JSON, commits that too, and references it:
 *   ![rules](https://img.shields.io/endpoint?url=<raw-url-to-the-json>)
 *
 * Honest by construction: the badge only ever says what the receipt says.
 * "passing" means no rule FAILED — UNCLEAR (needs judgment / no key) is not a
 * failure, same as everywhere else in the tool.
 */

export interface Badge {
  schemaVersion: 1;
  label: string;
  message: string;
  color: string;
}

export function buildBadge(summary: { pass: number; fail: number; unclear: number }): Badge {
  if (summary.fail > 0) {
    return { schemaVersion: 1, label: "rules", message: `${summary.fail} failing`, color: "red" };
  }
  if (summary.pass > 0) {
    return { schemaVersion: 1, label: "rules", message: "passing", color: "brightgreen" };
  }
  // Nothing failed and nothing deterministically passed — only judgment rules
  // with nothing to grade. Not green (that would overstate), not red.
  return { schemaVersion: 1, label: "rules", message: "unclear", color: "lightgrey" };
}
