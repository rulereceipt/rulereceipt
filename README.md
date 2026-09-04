# RuleReceipt

[![CI](https://github.com/rulereceipt/rulereceipt/actions/workflows/ci.yml/badge.svg)](https://github.com/rulereceipt/rulereceipt/actions/workflows/ci.yml)
[![CodeQL](https://github.com/rulereceipt/rulereceipt/actions/workflows/codeql.yml/badge.svg)](https://github.com/rulereceipt/rulereceipt/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/rulereceipt/rulereceipt/badge)](https://scorecard.dev/viewer/?uri=github.com/rulereceipt/rulereceipt)
[![npm](https://img.shields.io/npm/v/rulereceipt)](https://www.npmjs.com/package/rulereceipt)
[![provenance](https://img.shields.io/badge/npm-provenance%20signed-blue)](https://www.npmjs.com/package/rulereceipt#provenance)

Checks whether a Claude Code session actually followed the rules in your
CLAUDE.md / AGENTS.md — with evidence, not just a vibe.

Runs entirely on your machine. Plain `rulereceipt check` makes zero network
calls — [Trust, privacy and licensing](#trust-privacy-and-licensing) has the
full detail, including the three off-by-default opt-ins.

## See it in 10 seconds

```bash
npx rulereceipt demo
```

No install, no config, no API key, no real session needed — prints a sample
report so you can see the output shape immediately.

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
     instead of being checked. This step is a heuristic over English
     instruction words, so it can be wrong in both directions: run
     `rulereceipt check --show-skipped` once on your rules file to see
     exactly what it excluded. A rule phrased unusually, or written in
     another language, can land there — and a rule dropped silently is
     worse than one reported wrongly.

     When it gets one wrong, `rulereceipt rules --include <handle>` fixes it
     permanently. The handle is a hash of the rule's own text, not its
     position, so the correction survives edits elsewhere in the file. That
     matters more than making the classifier smarter: imperative verbs are
     not a closed class and the word list is English-only, so it will keep
     being wrong — it just needs to be correctable.
4. Prints a report — terminal table by default, `--markdown` for pasting
   into a PR or Slack message, or `--html` for a shareable single file —
   showing what passed, what failed, and a quoted line of evidence for
   each. Every report includes a SHA-256 hash of the session file it
   checked, so anyone with that file can confirm the report describes
   that exact file. (It proves the report matches the file, not that the
   file is an unmodified record — see SECURITY.md.)

## Usage

```bash
rulereceipt check              # check the latest session in this project
rulereceipt check --markdown   # same, formatted for pasting into a PR/Slack
rulereceipt check --html       # write a shareable single-file HTML report you can send
rulereceipt check --html report.html       # ...to a specific path
rulereceipt check --show-skipped           # list what was treated as documentation and not checked
rulereceipt check --require-session        # fail if there's no session, instead of passing silently
rulereceipt check --exit-zero              # report failures without failing the build
rulereceipt check --llm        # opt-in: grade judgment rules with your own Claude key
rulereceipt check --share      # opt-in: send anonymous pass/fail/unclear counts
rulereceipt check --telemetry  # opt-in: send one random per-machine ID
rulereceipt check --transcript <path>      # check a specific session file
rulereceipt rules              # show corrections you've made to what counts as a rule
rulereceipt rules --include <handle>   # "this IS a rule" — check it from now on
rulereceipt rules --exclude <handle>   # "this isn't" — stop reporting it
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

## Sharing a report

`rulereceipt check --html` writes one self-contained HTML file. No
external requests, no CDN, no fonts to fetch — so it opens correctly from
an email attachment, offline, years later, and prints cleanly to PDF.

It leads with what wasn't followed rather than burying it under passes,
quotes the evidence for each result, and states plainly what it does not
establish: it covers one session, it is not a compliance certification,
and rules needing judgment are reported as needing review rather than
guessed at. The session fingerprint and a runnable `rulereceipt verify`
command are printed on the report itself, so the person receiving it can
independently confirm it describes the session it claims to.

Nothing is uploaded. The file is written to your working directory and
goes wherever you choose to send it.

## Exit codes

`check` exits **1** when a rule was actually broken, and **0** otherwise,
so CI can gate on it. Rules that need human judgment report UNCLEAR and
never affect the exit code — most rules in a real CLAUDE.md need judgment,
and gating on those would make every build red on day one.

`--exit-zero` prints the report without failing the build. `--require-session`
does the opposite and is the one to use anywhere automated: it fails when
there is no session, or an empty one, instead of reporting a pass for a
check that never actually ran.

### A limit worth knowing before you wire this into CI

Claude Code writes its session transcript to the machine the agent ran on
— your laptop. A CI runner is a fresh machine that has never seen it, so a
CI job cannot check a session that happened on your laptop unless you
deliberately make that transcript available to the job. See
[templates/rulereceipt-ci.yml](./templates/rulereceipt-ci.yml), which
explains the options and, if you use it, fails loudly rather than passing
on a session it never found.

For most people the honest answer is simpler: run `rulereceipt check --html`
locally and attach the report to the PR.

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

## Trust, privacy and licensing

**Nothing leaves your machine unless you ask.** Your code, rules, and
session content never leave your computer, ever. Plain `rulereceipt check`
makes zero network calls. `--llm`, `--share`, and `--telemetry` are all
separate, off-by-default opt-ins: `--llm` calls the Claude API using your
own Anthropic key for rules that need judgment; `--share` sends aggregate
pass/fail/unclear counts; `--telemetry` sends one random per-machine ID so
real distinct-install counts are knowable, nothing else. None of them fire
unless you explicitly pass the flag, and `DO_NOT_TRACK=1` /
`RULERECEIPT_NO_TELEMETRY=1` forces telemetry off even if you do.

**Never writes anything you didn't ask for.** RuleReceipt never modifies
`.claude/settings.json` and installs no hooks. No automatic hooks, ever, in
v1 — it runs only when you type the command.

Two commands write, both only when you invoke them: `check --html` writes the
report to the path you name, and `rules --include/--exclude` records a
correction in `.rulereceipt/overrides.json`. Plain `rulereceipt check` writes
nothing and makes no network calls.

**You can verify the package came from this source.** Every release from
0.1.19 on is built and published by GitHub Actions and signed with
[npm provenance](https://docs.npmjs.com/generating-provenance-statements),
so you can verify the published package was built from this repository at
a specific commit. No publishing token exists to be stolen. Check it
yourself with `npm audit signatures` after installing.

**Licence.** Source-available software — see [LICENSE](./LICENSE) and
[NOTICE.md](./NOTICE.md) before reusing this code.

## Contact

Questions, bugs, or anything else — hello@rulereceipt.dev.
