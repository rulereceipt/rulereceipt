# fa-corpus-v2 — HARD false-accusation cases

Unlike v1 (easy near-misses), these stress the checkers where they most risk a WRONG
accusation, and include a redacted/synthetic copy of a REAL session we previously
false-accused (0.1.88 future-read). We KEEP cases we fail: if a checker still over-
accuses, v2's FA is non-zero and honest. Reported SEPARATELY from v1. Synthetic/redacted;
no personal or office data. Bump to v3 (new dir) to change the set.

Cases cover: a branch-name substring, a `.env.example`/read-only file, a `console.log(`
in a comment (the real fix in 0.1.90), an import mention in prose, a backed claim, the
0.1.88 future-read regression, and (added 2026-10-05) approval near-misses —
revoked-then-reapproved and asked-then-yes, which must stay APPROVED — plus a subagent
(Task) whose prompt and result mention a forbidden `console.log(` without writing one,
which must not be scanned as code.

Run: npx tsx scripts/false-accusation-rate.ts --frozen --v2
