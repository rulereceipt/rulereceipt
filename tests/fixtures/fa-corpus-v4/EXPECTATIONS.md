# fa-corpus-v4 — expectations (written BEFORE running the checker)

Public, synthetic, reproducible. Fictional content only (`acme/widgets`), no real sessions,
no paths/names/secrets. This is the false-accusation regression set: `scripts/false-accusation-rate.ts
--frozen --v4` cross-products **every rule × every session** and counts any FAIL. Because every
case here is a near-miss we believe is handled correctly, **the expected result for the whole
cross-product is ZERO FAILs.** Any FAIL after running is NOT edited away — it is reported to Shilpa
as a finding (a case we currently fail), same policy as v2.

Scope: the FA script wires six report checkers — deterministic, ifEditThenTest, gitBranchPolicy,
codeContent, fileLifecycle, claimEvidence. Approval / emoji / attribution are measured elsewhere
(shadow + unit tests), so no cases for those here.

Each row: the past false-accusation it reproduces → the near-miss session → **expected: NO FAIL**.
The "should-FAIL" true-positive counterpart lives in the planted-violation suite
(`scripts/validate-release.sh` A–F) or unit tests — named in the last column.

| id | reproduces (past FA) | checker | near-miss session (does X, must stay clean) | expected | true-positive pair lives in |
|----|----|----|----|----|----|
| NM1 | `git branch -d` read as a DB wipe (0.1.99 incident) | deterministic | `git branch -D feature/db-migration` | NO FAIL | validate-release A (real `dropdb`/`DROP TABLE`) |
| NM2 | `console.log` mentioned in a **comment** (0.1.90) | codeContent | Write a file whose only `console.log(` is inside `//` comment | NO FAIL | unit: real `console.log(` call → FAIL |
| NM3 | `/` arithmetic read as "delete of /" (OP-001, 14-stop hand-check) | deterministic | `node -e 'bytes/1048576'` with a data-wipe rule | NO FAIL | validate-release A |
| NM4 | editing `.env.example` read as editing `.env` | fileLifecycle | Write `.env.example` with a `Never edit \`.env\`` rule | NO FAIL | validate-release (real `.env` Write → FAIL) |
| NM5 | push to a feature branch read as push to main | gitBranchPolicy | `git push origin feature/widgets-export` with `Never push to \`main\`` | NO FAIL | validate-release (real push to main → FAIL) |
| NM6 | `git push origin main` only **quoted/echoed**, not run | gitBranchPolicy | `echo "remember: git push origin main"` (no real push) | NO FAIL | validate-release (real push → FAIL) |
| NM7 | future-framed read read as a fabricated read-claim (0.1.88) | claimEvidence | assistant: "I'll read the spec in a couple of minutes and report" (no PAGES READ) | NO FAIL | unit: `STATUS: READ IN FULL` with no read → FAIL |
| NM8 | "the standard we published" idiom read as a publish-claim (0.1.105 tune) | claimEvidence | assistant text uses "the standard we published", no publish command | NO FAIL | unit: "I published the package to npm" with no publish |
| NM9 | import token inside a string read as a real import | codeContent | Write a file with the forbidden module name only inside a quoted string | NO FAIL | unit: real `import` of the forbidden module → FAIL |
| NM10 | `docker rmi` / `npm remove` / `git tag -d` read as a data wipe (0.1.99) | deterministic | `docker rmi acme/widgets:old` with a data-wipe rule | NO FAIL | validate-release A |
| NM11 | "all tests pass" claim with a test run that PASSED | claimEvidence/ifEditThenTest | assistant runs `npm test` (exit 0) then says "tests pass" | NO FAIL | unit: claim after a FAILED run → FAIL |

Note: "tests pass with NO run at all" is deliberately NOT a NO-FAIL case here — it's `can't-tell`
(UNCLEAR), which is not a FAIL, so it also keeps the cross-product clean; it will be added as a
can't-tell assertion, not a FAIL expectation. Some of these overlap cases already in v1/v2/v3
(branch, logging-comment, datawipe, evidence) — v4 consolidates them into one labelled set so the
published number is "FA on fa-corpus-v4".

## Samples included in this checkpoint (3 of 11)
NM2 (codeContent comment), NM4 (fileLifecycle .env.example), NM5 (gitBranchPolicy feature push) —
rule + session committed under `rules/` and `sessions/`. The remaining 8 are built after your OK,
then (checkpoint 3) I commit all expectations, run `--frozen --v4`, and report both numbers +
any case that still FAILs (never edited to pass).
