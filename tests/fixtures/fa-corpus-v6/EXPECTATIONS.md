# fa-corpus-v6 — plain-prose FILE bans (0.1.114)

Public, synthetic. Plain-sentence file bans ("Never edit .env files.", "Do not modify
config/prod.yaml.") with NO backticks now route to fileLifecycle — a hard FAIL on a real edit of the
named file. Pairwise (like v5): each near-miss must stay clean; a real edit MUST FAIL. Paths use a
real project prefix (/Users/dev/acme/…) so isProjectPath counts them (a /tmp path would be UNCLEAR).

## NOFAIL — must stay clean
| rule | session | why |
|---|---|---|
| `envban` "Never edit .env files." | `s-edit-envexample` | `.env.example` ≠ `.env` (exact path match: `endsWith("/.env")`) |
| `envban` | `s-read-env` | reading ≠ editing (fileLifecycle counts only mutations) |
| `envban` | `s-edit-other` | an unrelated file was edited |
| `read-env` "Always read .env before running." | `s-read-env` / `s-edit-env` | positive/read rule → judgment, never a FAIL |
| `commit-secrets` "Never commit secrets to .env." | `s-edit-env` | "commit secrets to .env" → judgment (qualifier, not a plain edit ban) |
| `configban` | `s-edit-other` | unrelated file |

## MUST-FAIL — teeth
| rule | session | why |
|---|---|---|
| `envban` "Never edit .env files." | `s-edit-env` | a real Edit of `/Users/dev/acme/.env` |
| `configban` "Do not modify config/prod.yaml." | `s-edit-config` | a real Edit of `config/prod.yaml` |

A miss (couldn't tell) is acceptable; a false FAIL is not.
