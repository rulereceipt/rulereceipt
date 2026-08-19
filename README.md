# RuleReceipt

Checks whether a Claude Code session actually followed the rules in your
CLAUDE.md / AGENTS.md — with evidence, not just a vibe.

Licensed source-available software — see [LICENSE](./LICENSE) and
[NOTICE.md](./NOTICE.md) before reusing this code.

Runs entirely on your machine by default. Your code and session content
never leave your computer — the only network call by default is your own
Claude API key talking to Anthropic, the same as normal Claude Code usage.
`rulereceipt check --share` is opt-in only and, if you use it, sends
nothing but aggregate pass/fail/unclear counts — never rule text, file
paths, or session content. Without `--share`, no usage data is ever sent
anywhere.

**Security note:** RuleReceipt never modifies `.claude/settings.json` and
installs no hooks without explicit action. It only ever reads your
CLAUDE.md/AGENTS.md and session transcripts — read-only, manual invocation
only (`rulereceipt check`). No automatic hooks, ever, in v1.

## Status

Published and live on npm. Core CLI is built and tested (100 tests
passing).

## How it works

1. Reads your CLAUDE.md / AGENTS.md and extracts individual rules —
   from the current project directory and `~/.claude/CLAUDE.md`.
2. Reads your most recent Claude Code session transcript (stored locally
   at `~/.claude/projects/...`).
3. Splits rules into two kinds:
   - **Deterministic** — checkable by plain pattern matching (a rule
     naming a specific literal in backticks, e.g. "never use
     `git push --force`"). No AI call, no cost, no data exposure.
   - **Judgment** — needs actual understanding (e.g. "surface bad news
     first"). Checked via one batched API call using *your own* Claude
     API key. If no key is set, these rules report UNCLEAR with an
     explanation — never a silent guess at PASS.
4. Prints a report — terminal table by default, or `--markdown` for
   pasting into a PR or Slack message — showing what passed, what
   failed, and a quoted line of evidence for each. Every report includes
   a SHA-256 hash of the session file it checked, so anyone with that
   file can independently confirm the report matches a real, unaltered
   session.

## Try it with zero setup

```bash
rulereceipt demo
```

No install config, no API key, no real session needed — prints a sample
report so you can see the output shape immediately.

## Usage

```bash
rulereceipt check              # check the latest session in this project
rulereceipt check --markdown   # same, formatted for pasting into a PR/Slack
rulereceipt check --share      # opt-in: also send anonymous pass/fail/unclear counts
rulereceipt demo               # sample output, no setup needed
rulereceipt demo --markdown
rulereceipt --version          # print the installed version
rulereceipt verify <session-file> <hash>   # spot-check a report you received against the real session file
```

`verify` isn't a routine check — trust your team day to day, same as any status update. It's there for the rare case it actually matters (a dispute, an incident review): give it the session file and the hash printed in the report, and it confirms whether they really match.

## Install

```bash
npm install -g rulereceipt
rulereceipt demo
```

### Local dev, from this repo

```bash
npm install
npm run build
npm run typecheck
npm test
npx tsx src/cli.ts demo
```

## Contact

Questions, bugs, or anything else — developer@rulereceipt.dev.
