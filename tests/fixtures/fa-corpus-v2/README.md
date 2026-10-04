# fa-corpus-v2 — HARD false-accusation cases

Unlike v1 (easy near-misses), these stress the checkers where they most risk a WRONG
accusation, and include a redacted/synthetic copy of a REAL session we previously
false-accused (0.1.88 future-read). We KEEP cases we fail: if a checker still over-
accuses, v2's FA is non-zero and honest. Reported SEPARATELY from v1. Synthetic/redacted;
no personal or office data. Bump to v3 (new dir) to change the set.

Run: npx tsx scripts/false-accusation-rate.ts --frozen --v2
