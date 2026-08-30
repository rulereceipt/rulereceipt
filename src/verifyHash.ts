import { computeTranscriptHash } from "./report/generateReport.js";

export interface VerifyResult {
  match: boolean;
  fullHash: string | null;
  checkedAgainst: string;
}

/**
 * Reports only ever print a truncated hash (first 16 hex chars + "...",
 * see generateReport.ts) — a manager copy-pasting from a real report will
 * have "sha256:08a04a985872362c...", not the full 64-char hash. Strip the
 * prefix/suffix so that truncated form still verifies correctly.
 */
function normalizeHashInput(input: string): string {
  return input
    .trim()
    .replace(/^sha256:/i, "")
    .replace(/\.+$/, "")
    .toLowerCase();
}

// A real report always prints exactly 16 hex chars (see generateReport.ts).
// Anything shorter isn't a truncated real hash, it's a forgery attempt or a
// typo — accepting it as a MATCH would mean a claimed hash as short as one
// hex char matches roughly 1 in 16 unrelated session files purely by chance
// (confirmed: 15/200 unrelated files spuriously matched claim "a" in a real
// test run), which defeats the entire point of this tool.
const MIN_VERIFIABLE_PREFIX_LENGTH = 16;

/**
 * Spot-check tool, not a routine gate: confirms whether a session file's
 * real hash matches a hash someone gave you in a report — a prefix match
 * against the truncated form is a MATCH, since that's all a report ever
 * shows. Never throws; a missing/unreadable file is a real, reportable
 * MISMATCH-shaped result (fullHash: null), not a crash.
 */
export function verifySessionHash(sessionFilePath: string, claimedHash: string): VerifyResult {
  const fullHash = computeTranscriptHash(sessionFilePath);
  const checkedAgainst = normalizeHashInput(claimedHash);
  const match =
    fullHash !== null &&
    checkedAgainst.length >= MIN_VERIFIABLE_PREFIX_LENGTH &&
    fullHash.startsWith(checkedAgainst);
  return { match, fullHash, checkedAgainst };
}
