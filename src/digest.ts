import type { HistoryEntry } from "./history.js";

/**
 * A non-technical summary — a manager doesn't want 30 individual
 * reports, they want "how many, how many were clean, what needs a
 * look." No rule text, no evidence, just counts and dates.
 */
export function generateDigest(entries: HistoryEntry[], periodLabel: string): string {
  if (entries.length === 0) {
    return `RuleReceipt — ${periodLabel} summary\n\nNo sessions checked in this period.`;
  }

  const clean = entries.filter((e) => e.fail === 0);
  const withFailures = entries.filter((e) => e.fail > 0);

  const lines: string[] = [];
  lines.push(`RuleReceipt — ${periodLabel} summary`);
  lines.push("");
  lines.push(`${entries.length} session${entries.length === 1 ? "" : "s"} checked`);
  lines.push(`${clean.length} clean, ${withFailures.length} had at least one failure`);

  if (withFailures.length > 0) {
    lines.push("");
    lines.push("Sessions with failures:");
    for (const e of withFailures) {
      const date = new Date(e.timestamp).toISOString().slice(0, 10);
      lines.push(`  ${date} — ${e.fail} failed, ${e.unclear} unclear, ${e.pass} passed`);
    }
  }

  return lines.join("\n");
}
