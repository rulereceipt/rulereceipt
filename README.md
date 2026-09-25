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
rulereceipt rules --coverage   # which rules a configured hook might actually enforce
rulereceipt doctor             # list hooks/auto-run tasks configured on this machine
rulereceipt hook               # run AS a Claude Code Stop hook — block Claude finishing on a broken rule
rulereceipt guard              # run AS a Claude Code PreToolUse hook — refuse a call before it runs
rulereceipt lint               # find contradictions between CLAUDE.md and AGENTS.md
rulereceipt digest             # summarise recent checks; --email to send it
rulereceipt config             # set up email sending (stays on your machine)
rulereceipt demo               # sample output, no setup needed
rulereceipt demo --markdown
rulereceipt --version          # print the installed version
rulereceipt verify <session-file> <hash>   # spot-check a report you received against the real session file
```

`verify` isn't a routine check — trust your team day to day, same as any status update. It's there for the rare case it actually matters (a dispute, an incident review): give it the session file and the hash printed in the report, and it confirms whether they really match.

### Claims of having read something

A session that writes `PAGES READ: 1-20`, `STATUS: READ IN FULL` or "confirmed
at source" while never opening a file is asserting provenance it does not
have. Reported by a user in anthropics/claude-code#92505, where those headers
went into tracked files and commit messages for material the model had never
read.

The check is narrow on purpose. It fires only when **nothing at all** was read
in the session — no `Read`, no `Grep`, no `cat`. That much a transcript can
prove, and it contradicts any claim of reading. It cannot tell you *which*
document was read when reads did happen, so a session that read the wrong
thing is still beyond it, and the report says so rather than guessing.

"I will read the filing next" is a plan, not a claim, and does not fire.

## Blocking, not just reporting

`rulereceipt check` tells you afterwards. `rulereceipt hook` refuses to let the
session end.

Add this to `.claude/settings.json` — you add it, we never do:

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [ { "type": "command", "command": "npx rulereceipt hook" } ] }
    ]
  }
}
```

When Claude tries to finish, it reads the session that just happened. If a rule
was broken it hands Claude the rule, the evidence, and instructions to keep
working, so the session cannot end on a claim that isn't backed.

The one it is actually for: *"Done — all tests pass"* when the last run of
`npm test` returned two failures. It checks the claim against what ran, which
is the part a model cannot talk its way around.

Three properties worth knowing before you wire it in:

- **It blocks two things, both narrow.** A claim a recorded run contradicts,
  and a claim of done that nothing in the session verified. Never a judgment
  rule, never an LLM opinion. Run against thirteen real sessions it stopped
  two, and both were read by hand.
- **The report and the gate disagree in exactly one place.** When a session
  claims work is done and nothing recorded verifies it, the report says
  "couldn't tell" — the tests may have run in another terminal, and a
  transcript cannot see that. The gate refuses the exit anyway, because it is
  not saying the claim is false. It is declining to let "done" end a session
  with nothing behind it.
- **It cannot loop.** Claude Code sets `stop_hook_active` when a session is
  already continuing because of a block; the hook returns immediately in that
  case. One interruption per stop.
- **It fails open.** Unreadable transcript, missing rules file, a bug in us —
  it allows the stop and writes a line to stderr. Failing closed would mean our
  bug locks you out of finishing your own session. That is a deliberate
  weakening, and it is why `check` in CI stays the backstop.

It runs when Claude stops, so it catches a finished session, not a command
mid-flight. For that, use a `PreToolUse` hook of your own — `rulereceipt
doctor` will show you what you already have.

### Refusing a command before it runs

`rulereceipt guard` runs as a `PreToolUse` hook and refuses a call outright:

```json
{
  "hooks": {
    "PreToolUse": [
      { "hooks": [ { "type": "command", "command": "npx rulereceipt guard" } ] }
    ]
  }
}
```

Read the limit before wiring it in, because it is most of the story. It
enforces rules naming a **file** or a **branch** — "never modify `.env`",
"never commit to `main`" — and nothing else.

It does **not** block a banned command unless you have said which command is
banned. That was the point of building it, and the automatic version did not
survive measurement: replaying 16,336 real tool calls against every forbidding
rule in a 559-file corpus, blocking on command literals refused 62.8% of them.
Narrowing twice reached 2.5%, and the residue was still wrong in a way no
matcher fixes — one rule refused `npm run build` 112 times, because it forbids
running Playwright unprompted and *recommends* `npm run build`, which is its
only command-shaped literal.

Nothing in a rules file marks which backtick is the prohibition. A report
survives that by saying UNCLEAR. A gate cannot — so you mark it:

```bash
rulereceipt rules --forbid <handle> --literal "git push --force"
```

Handles come from `rulereceipt rules --handles`. The mark is stored
against the rule's content hash, and the guard blocks on that literal and no
other. Three things it deliberately will not do:

- An **unmarked** rule cannot block, at any confidence, ever. There is no
  fallback to "probably the first literal" — that fallback is the bug.
- **Rewording the rule drops the mark.** It would otherwise carry your
  judgment onto words you never read.
- A mark naming a literal the rule no longer contains is **ignored**. A gate
  refusing a command for a reason written nowhere is the worst failure a gate
  has.

Of 99 forbidding rules in the corpus that name a command-shaped literal, only
43 have a prohibition that actually introduces one. The rest could never be
marked automatically, which is the point.


### Reproducing the published numbers

Every figure in the [postmortem](https://rulereceipt.dev/postmortem) and in the
issue threads is measured over 559 public rules files. The list of those files
is committed as `rule_file_corpus.md`; the files themselves are not, because
they belong to other projects.

```bash
bash scripts/fetch-corpus.sh 600      # the default is 60
npx tsx scripts/corpus-report.ts      # where real rules route: 63.2% not instructions
npx tsx scripts/false-accusation-rate.ts   # reports carrying a false accusation
npx tsx scripts/verb-gate.ts          # which gate admits each rule
npx tsx scripts/guard-replay.ts corpus 3   # what the PreToolUse guard would refuse
```

The list holds 563 URLs and yields 559 files — four have moved or been deleted
upstream since it was drawn on 2026-08-30. That gap is expected and will grow;
if your count differs from 559, that is why, and the routing percentages move
by a rounding error rather than meaningfully.

Two of these print a sha256 for every session they read. That is deliberate:
"the largest sessions on this machine" is a selection rule, not a pin, and the
largest include the session doing the measuring. Two runs of identical code
four days apart returned 14,033 and 9,605 tool calls. Numbers are comparable
only when those hashes match.

## Which rules actually have teeth

A rule in a file and a rule with a `PreToolUse` hook behind it look identical
when you read them, and behave completely differently when they're ignored.
One fails loudly; the other doesn't fail at all.

```bash
rulereceipt rules --coverage
```

This lists your rules against the hooks configured on this machine and in the
project, and tells you which rules name something a *blocking* hook also
names. Hooks on events that can't refuse anything — `SessionStart`,
`PostToolUse` — are counted separately, because they can log or inject
context but can't make a rule fail.

**It reports a possible backing, never a proof, and says so in its own
output.** A hook's command is usually a path to a script this tool doesn't
read, so the only evidence available is the event, the matcher, and literal
text in the command. Both mistakes are possible: a hook can guard a rule
while sharing no wording with it, and shared wording doesn't mean the hook
guards it. Treat the links as somewhere to look, and everything else as prose
until you've checked.

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

### The GitHub Action and the receipt flow

The concrete way to gate in CI: produce a **receipt** where the session
lives, verify it where it doesn't.

Locally (the session is on your machine), produce and commit a receipt:

```bash
rulereceipt check --json > .rulereceipt/receipt.json   # commit this file
```

In CI (no session), verify the committed receipt with the Action:

```yaml
- uses: rulereceipt/rulereceipt@main   # pin to a release tag once one is cut
  with:
    receipt: .rulereceipt/receipt.json
    max-age-days: "7"                  # optional: reject a stale receipt
    # anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}  # optional: also fail on CLAUDE.md↔AGENTS.md contradictions
```

The build **fails** unless the receipt is a real, current, passing
RuleReceipt receipt. The Action also prints a session-independent audit of
your CLAUDE.md (`rules --coverage`), and — only if you pass an API key —
fails on a CLAUDE.md-vs-AGENTS.md contradiction.

Or run the pieces directly:

```bash
rulereceipt verify-receipt .rulereceipt/receipt.json --max-age-days 7
```

**Honest trust boundary:** with no session, CI trusts the receipt you
committed. But if the session *is* available — agentic CI, or you upload the
transcript — pass it and CI re-derives instead of trusting:

```bash
rulereceipt verify-receipt .rulereceipt/receipt.json --session path/to/session.jsonl
```

That re-hashes the session and **rejects a receipt that doesn't match it**
(forged, tampered, or the wrong session) — no trust required. For the
no-session case, trust remains until signed/attested receipts land; a
self-signed receipt would not help (the author holds the key), so the honest
closure is session re-verification where the session exists.

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

**Severity, per rule.** A committed, team-shared `.rulereceipt/config.json`
sets how hard each rule bites in CI, by its stable handle (from `rulereceipt
rules --list`):

```json
{
  "rules": {
    "a1b2c3": "off",     // hidden from the report, never gates
    "d4e5f6": "warn",    // shown, but does not fail the build
    "97h8i9": "error"    // shown, FAILS the build — the default for a checkable rule
  },
  "checks": {
    "emoji": "off",      // silence a whole check type by name
    "git": "warn"        // emoji, attribution, approval, git, files, code, claim, tests, judgment
  }
}
```

A per-rule `rules` entry wins over a per-check `checks` entry, which wins over
the default. No config means today's behaviour: every checkable FAIL is an
`error`. This is
the one place severity lives — a team marks the must-not-break rules `error`
and the nice-to-haves `warn`, so CI gates on what matters instead of going red
on day one. (Refusing a command *before* it runs is separate, and stays with
the guard's `rules --forbid` clause-mark — a config that could block on any
rule would refuse far too much.) The older `{"warn": ["a1b2c3"]}` list still
works and means the same as `"warn"` above.

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
