# RuleReceipt

Checks whether a Claude Code session actually followed the rules in your
CLAUDE.md / AGENTS.md — with evidence, not just a vibe.

Licensed source-available software — see [LICENSE](./LICENSE) and
[NOTICE.md](./NOTICE.md) before reusing this code.

Runs entirely on your machine. Your code, rules, and session content never
leave your computer, ever. Plain `rulereceipt check` makes zero network
calls. `--llm`, `--share`, and `--telemetry` are all separate, off-by-default
opt-ins: `--llm` calls the Claude API using your own Anthropic key for rules
that need judgment; `--share` sends aggregate pass/fail/unclear counts;
`--telemetry` sends one random per-machine ID so real distinct-install
counts are knowable, nothing else. None of them fire unless you explicitly
pass the flag, and `DO_NOT_TRACK=1` / `RULERECEIPT_NO_TELEMETRY=1` forces
telemetry off even if you do.

**Security note:** RuleReceipt never modifies `.claude/settings.json` and
installs no hooks without explicit action. It only ever reads your
CLAUDE.md/AGENTS.md and session transcripts — read-only, manual invocation
only (`rulereceipt check`). No automatic hooks, ever, in v1.

## Status

Published and live on npm, actively developed.

## How it works

1. Reads your CLAUDE.md / AGENTS.md and extracts individual rules —
   from the current project directory and your global rules file.
2. Reads your most recent Claude Code session transcript, wherever Claude
   Code stored it — including hosted or enterprise variants that use a
   different directory.
3. Routes each rule to the narrowest check that can actually answer it:
   - **Structured checks** read what the session really did — an actual
     git command's branch argument, actual file edits, actual file
     operations. These are the only checks that report a confident FAIL,
     because they can tell an action from a mention.
   - **Literal checks** look for a specific string named in the rule.
     Absence is real evidence, so a clean session PASSes. A match reports
     UNCLEAR with the text quoted, because a text match alone cannot
     distinguish doing the forbidden thing from grepping for it, quoting
     it, or naming it in a commit message.
   - **Judgment** rules need real understanding (e.g. "surface bad news
     first"). With `--llm` each is graded individually using *your own*
     Claude key; without it they report UNCLEAR rather than guessing.
   - Lines containing no instruction at all — directory listings,
     reference tables, examples — aren't rules, and are reported as such
     instead of being checked.
4. Prints a report — terminal table by default, or `--markdown` for
   pasting into a PR or Slack message — showing what passed, what
   failed, and a quoted line of evidence for each. Every report includes
   a SHA-256 hash of the session file it checked, so anyone with that
   file can confirm the report describes that exact file. (It proves the
   report matches the file, not that the file is an unmodified record —
   see SECURITY.md.)

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
rulereceipt check --llm        # opt-in: grade judgment rules with your own Claude key
rulereceipt check --share      # opt-in: send anonymous pass/fail/unclear counts
rulereceipt check --telemetry  # opt-in: send one random per-machine ID
rulereceipt check --transcript <path>      # check a specific session file
rulereceipt doctor             # list hooks/auto-run tasks configured on this machine
rulereceipt lint               # find contradictions between CLAUDE.md and AGENTS.md
rulereceipt digest             # summarise recent checks; --email to send it
rulereceipt config             # set up email sending (stays on your machine)
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

Questions, bugs, or anything else — hello@rulereceipt.dev.
