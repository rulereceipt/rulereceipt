# Third-party licensing decisions

One entry per external component we reuse, depend on, or learned facts from. Checked
against the actual LICENSE where noted. A CI licence gate (`npm run license:check`) fails
the build on any production dependency outside the permissive allow-list, or any
`LicenseRef-*` / AGPL / GPL licence.

Allow-list: MIT, MIT-0, ISC, 0BSD, BSD-2-Clause, BSD-3-Clause, Apache-2.0, BlueOak-1.0.0,
Python-2.0, Unlicense, CC0-1.0.

## Runtime dependencies (shipped)

| Package | Version | Licence | Checked | Note |
|---|---|---|---|---|
| @anthropic-ai/sdk | ~0.126.0 | MIT | 2026-10-01 | only used behind `--llm` (your own key) |
| commander | ~15.0.0 | MIT | 2026-10-01 | CLI framework |
| nodemailer | ~10.0.1 | MIT | 2026-10-01 | only used by the opt-in email digest |

All production deps passed the licence gate (10 packages incl. transitive, all permissive).

## Reused / planned (forked for preservation)

| Project | URL | Licence | Checked | What we use | Decision |
|---|---|---|---|---|---|
| agnix | github.com/agent-sh/agnix | Apache-2.0 | 2026-09-30 | optional runtime add-on (config checks) | fork rulereceipt/agnix; integrate as optional, never a dependency |
| rulesync | github.com/dyoshikawa/rulesync | MIT | 2026-09-30 | reference: where each agent keeps rules files | fork rulereceipt/rulesync; knowledge + possible small ports with MIT notice |
| deja-vu | github.com/vshulcz/deja-vu | MIT | 2026-09-30 | redaction pattern list; session-format reference (Go) | fork rulereceipt/deja-vu; re-implement patterns in TS, credit in NOTICE |

## Knowledge-only (clean-room — read for facts, copy NO code/rules/fixtures/text)

The following carry a non-standard "MIT License (with OpenAI/Anthropic Rider)". The rider
grants no rights to OpenAI, Anthropic, their affiliates, or anyone acting for them, makes
any transfer to them null and void, and requires the rider be carried unmodified in any
derivative. Copying their code would make RuleReceipt unsellable to two likely acquirers
and a diligence red flag for the rest (full analysis in local/LICENSES-RESEARCH.md).

| Project | URL | Licence | Clean-room note |
|---|---|---|---|
| cass (coding_agent_session_search) | github.com/Dicklesworthstone/coding_agent_session_search | MIT + OpenAI/Anthropic Rider | Read its README/LICENSE on 2026-09-30 for WHERE agents store sessions and WHAT formats. No code, rule lists, or fixtures copied. |
| casr (cross_agent_session_resumer) | github.com/Dicklesworthstone/cross_agent_session_resumer | MIT + OpenAI/Anthropic Rider | Same: facts only, no code copied. Not forked. |
| destructive_command_guard (dcg) | github.com/Dicklesworthstone/destructive_command_guard | MIT + OpenAI/Anthropic Rider | Prior art for a PreToolUse guard. Read for ideas only; no rule packs copied. Not forked. |

## Avoid completely
- TruffleHog (AGPL-3.0) — no code or regexes.
- secrets-patterns-db (CC-BY-4.0 but contains AGPL-derived rules) — mixed provenance.
- Claude Code's own source (commercial licence) — rely only on public docs + files on disk.

## Git-history scan (2026-10-01)
Scanned the FULL history with `git log -S` for "OpenAI/Anthropic Rider", "Dicklesworthstone",
"coding_agent_session_search", "cross_agent_session_resumer", "destructive_command_guard",
"trufflehog", "secrets-patterns-db": **0 occurrences** in history, **0** in `src/`. No tainted
code has ever been committed.

## GuardFall corpus — clean-room, knowledge-only (2026-10-04)
GuardFall is the adversarial guard-bypass corpus in **samvallad33/vestige**, which is
**AGPL-3.0-only**. We treat it as **knowledge-only**: we may read its *category names* and
the *classes of bypass* it describes (redirection-first, `git -C`, `eval`, pipe-to-
interpreter, env/VAR= prefixes, `sh`/`bash -c` nesting, heredocs, etc.), but we **do NOT
copy any of its cases, data, fixtures, or code into this repository — not even into
tests**. Our own bypass/adversarial tests are written from scratch against those
categories, with our own commands and expectations, and credited as inspiration only.
Same rule as the vestige/Operator Lite entry: AGPL copyleft, so reimplement ideas, never
copy text. No GuardFall string, case, or file may appear in `git log` for this repo.
