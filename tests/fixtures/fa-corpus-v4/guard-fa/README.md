Datawipe/delete near-misses. The REPORT checker is can't-tell for deletes (a transcript
can't tell whether a delete hit the protected data), so these can never hard-FAIL and
cannot false-ACCUSE in the report. Their real past FP (0.1.99 `git branch -d` block) was a
GUARD false-block — regression-tested in tests/guardDeleteFP.test.ts. NOT counted in the public report FA%.
