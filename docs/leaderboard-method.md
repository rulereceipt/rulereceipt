# Leaderboard method — draft

**Status: draft. Method before numbers.** This document fixes *how* RuleReceipt
would measure and publish "which agents follow written rules best" **before** any
ranking is published, so the leaderboard is reproducible and credible from day one.
No per-agent ranking is published yet (see [Not yet](#not-yet-published)).

The rule behind everything here: **a wrong verdict is the worst bug.** The method
is built to make the tool's own error rates measurable and public first, and the
agent ranking second.

## The two things measured

A rule checker can be wrong in two directions. Both are measured, separately, and
neither is hidden behind the other.

### 1. False-accusation rate (false alarm)

The share of reports that contain **at least one `FAIL`** when run over a corpus
where a FAIL is spurious by construction. This is a **ceiling**, not a count of
real false accusations: the corpus rules belong to other people's projects and the
sessions do not, so almost any FAIL is wrong by construction. The number should sit
near zero, and any movement in it is a real change in how readily the tool accuses.

- **Input (frozen, public):** `tests/fixtures/fa-corpus-v1..v4` — committed,
  versioned, synthetic sessions, read with no home-directory access, so anyone can
  reproduce the number from the repo alone.
- **Reproduce:**
  ```bash
  npx tsx scripts/false-accusation-rate.ts --frozen        # v1
  npx tsx scripts/false-accusation-rate.ts --frozen --v2   # v2 (hard cases)
  npx tsx scripts/false-accusation-rate.ts --frozen --v3
  npx tsx scripts/false-accusation-rate.ts --frozen --v4   # one near-miss per past false-accusation
  ```
- **Current:** 0 FAIL (0.0%) across v1–v4. Every past false accusation becomes a
  permanent near-miss fixture in a later version, so the number can only be held
  honest by cases the tool once got wrong.

### 2. False-pass rate (missed break)

Whether a **known, planted** violation is actually caught. A planted break that
the tool reports as `PASS` or `UNCLEAR` instead of `FAIL` is a false pass.

- **Input:** per-agent planted-violation + clean fixtures — one planted break and
  one clean session per supported agent (e.g. `tests/*Adapter.test.ts`,
  `tests/*Verdict.test.ts`, `tests/fixtures/codex0160/`). The clean session must
  stay `FAIL`-free; the planted one must produce the expected `FAIL`.
- These run in the normal test suite; a regression in either direction fails CI.

## The corpus

| Set | What | Where | Published? |
|---|---|---|---|
| Frozen FA corpora | Synthetic sessions, versioned v1–v4 | `tests/fixtures/fa-corpus-v*` | Yes (in repo) |
| Public rules corpus | Real public rules files | `corpus/` | Yes (in repo) |
| Planted/clean per agent | One break + one clean per agent | `tests/` fixtures | Yes (in repo) |
| Private session snapshot | Frozen sha256-pinned real sessions | local, gitignored | No — numbers only |

The private snapshot is used only to confirm a change moves **zero** verdicts
between releases (a frozen before/after diff); its contents are never published,
only the diff result (e.g. "0 of 118,888 verdicts changed").

## Hold-out (the real-world number)

Any fix tuned on the maintainer's own sessions is **in-sample** and is labelled as
such — it is not the published real-world number. The published number comes from a
**hold-out**: sessions created *after* the tuning date, never used to tune, measured
once. The first hold-out re-measure is scheduled for **2026-10-25** (fresh sessions
created after 2026-10-11). The three advisory shadow signals are re-measured on the
same hold-out set at the same time.

## Honesty rules (apply to every published number)

- Report **"N of M checks"** / counts, never a bare "0%".
- Label **IN-SAMPLE** vs hold-out. Only hold-out / out-of-sample counts toward a
  published claim.
- When n < 40, say so next to the number.
- Shadow signals are advisory and are **never** counted as verdicts or in any rate.
- Session selection is deterministic and printed in the output: a measurement
  whose inputs move is not a measurement.

## Not yet published

No per-agent ranking is on the site. A leaderboard ships only once (a) the
hold-out real-world false-accusation and false-pass numbers exist per agent, and
(b) the planted/clean fixture set is complete for each ranked agent. Until then the
only published numbers are the frozen-corpus rate and the in-sample "N of M, fixed"
line.
