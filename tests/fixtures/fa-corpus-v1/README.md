# fa-corpus-v1 — frozen false-accusation benchmark

A committed, versioned, synthetic set so the false-accusation number moves ONLY
when the checkers change — never when a machine's own sessions drift.

- `rules/` — synthetic rules files across the real categories (branch, secrets,
  code content, claim-evidence, approval gate, judgment, attribution, emoji,
  imports, documentation, mixed-polarity, conditional).
- `sessions/` — synthetic Claude Code transcripts that are realistic NEAR-MISSES:
  a push to a feature branch (not `main`), editing `.env.example` (not `.env`), a
  grep that mentions `console.log(` (not a write), a backed "tests pass" claim, the
  prescribed `gh pr merge --merge` (not a squash), a future plan (not a done action).
  A correct tool should raise ZERO false accusations on these.

Run: `npx tsx scripts/false-accusation-rate.ts --frozen`
No personal or office data. Bump to `fa-corpus-v2` (new directory) to change the set;
never edit v1 in place, so published numbers stay comparable.
