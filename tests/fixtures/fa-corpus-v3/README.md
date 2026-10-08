# fa-corpus-v3 — deletes that are NOT data-store wipes

A ceiling on one false-accusation class: a *wipe/delete the database* rule must
fire only on real data-destroying commands (`rm` on a db file, `DROP`, `dropdb`,
`FLUSHALL`), never on version-control, image, or package deletes.

Real incident 2026-10-08: the guard blocked `git branch -d` as a data wipe,
citing a *Never wipe data storage databases* rule. Fixed in approvalGate.ts
(`NOT_A_DATA_WIPE`, and `git …-D` removed from the delete-action pattern).
guardDeleteFP.test.ts covers the guard path directly; this corpus pins the
check path: every rule here against every session must yield 0 FAIL.

Sessions: git branch -d / -D, git tag -d, git stash drop, git worktree remove,
docker rmi, npm uninstall — each with NO approval in the chat.
