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
  const match = fullHash !== null && checkedAgainst.length > 0 && fullHash.startsWith(checkedAgainst);
  return { match, fullHash, checkedAgainst };
}
