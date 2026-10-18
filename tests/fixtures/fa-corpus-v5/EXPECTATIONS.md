# fa-corpus-v5 — permanent lock for the plain-prose branch-rule false accusations

Public, synthetic, reproducible. Fictional content only (`acme/widgets`). These are the exact
cases the independent reviewer + the frozen-44 diff caught when the plain-prose "never push to
main" path (Feature B) was first built for 0.1.111 — it dropped qualifiers, crossed clauses, and
captured the wrong token, turning narrow or figurative rules into hard FAILs on an ordinary push.
B was pulled from 0.1.111 for exactly these. This set locks them so they can never come back
(Shilpa, 2026-10-17: "so they can never come back").

Unlike v1–v4 (blind rule×session cross-products) this set is PAIRWISE: a plain "never push to
main" rule and a successful push-to-main session cannot both live in one 0-FAIL cross-product (the
pair is a TRUE violation), so each rule is matched to the specific session that makes it a
near-miss. Any NOFAIL pair that FAILs is a false accusation.

## NOFAIL — must stay clean (the 8 regressions + near-misses)
| rule (plain prose, no backticks) | session | why it must NOT FAIL |
|---|---|---|
| `force-push` "Never force-push to main." | `s-push-main` | bans force-push, not a plain push (qualifier on the verb) |
| `merge-prs` "Never merge PRs into main." | `s-push-main` | a merge-PR rule, not a push ban |
| `push-secrets` "Avoid pushing secrets to main." | `s-push-main` | bans pushing SECRETS; checker can't see what was pushed |
| `mixed-polarity` "Never rebase, and always deploy to main." | `s-push-main` | mixed polarity; "main" belongs to a positive clause |
| `merge-hotfix` "Never merge the hotfix branch into production." | `s-push-hotfix` | protects production via a merge; pushing the hotfix branch is fine |
| `push-blame` "Don't push blame onto main." | `s-push-main` | figurative ("push blame"), not a git push |
| `incomplete-features` "Don't merge incomplete features into main." | `s-push-main` | a merge-of-incomplete-work rule (microsoft/PowerToys), not a push ban |
| `main-or-trunk` "Never push to main or trunk." | `s-local-commit` | a local commit is not a push; "or" is not a branch |
| `commit-to-main` "# 1. … never commit to main" | `s-push-main` | a "commit" rule (here a workflow-step comment) must not FAIL a push — prose path is push-only (tryvit, frozen-44 2026-10-18) |
| `clean-pushban` "Never push to main." | `s-failed-push-main` | the push was rejected — it never reached main |
| `clean-pushban` | `s-main-word` | "main" used as an ordinary word; no git ref op |
| `clean-pushban` | `s-feature-push` | push to a feature branch, not main |
| `clean-pushban` | `s-commit-msg-push` | "push to main" only inside a commit message; no push ran |
| `clean-pushban` | `s-local-commit` | a local commit, no push |
| `ordinary-main` "Keep the main function small…" | `s-push-main` | not a branch rule at all ("main" as adjective) |

## MUST-FAIL — teeth (prove the set is not vacuous and the detection really fires)
| rule | session | why it MUST FAIL |
|---|---|---|
| `clean-pushban` "Never push to main." | `s-push-main` | a real successful push to main — the plain-prose path must catch it |
| `clean-pushban` | `s-pushmain-id-unrelated-error` | push to main has a tool id but no result; an unrelated later error must NOT suppress it (commandErrored: tool id is authoritative, no positional fallthrough) |

Gate: every NOFAIL pair clean AND every MUST-FAIL pair FAILs. If the prose path cannot keep a case
clean, it must route that rule to judgment ("couldn't tell") instead — a miss is acceptable, a
false FAIL is not.
