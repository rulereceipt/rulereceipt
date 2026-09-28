# Known gaps

What RuleReceipt cannot see, cannot decide, or does not do yet.

A verdict is only as good as the evidence behind it, so this file lists where the
evidence runs out. When the tool hits one of these gaps it should say **Can't tell**,
not guess. If you ever see it guess instead, that is a bug: please report it with
`rulereceipt wrong <rule>`.

_Last reviewed: 2026-09-28, against 0.1.60 (one engine for check, hook and report;
per-action approval check; `rulereceipt wrong`; audit load graph). Update this file with
every release._

---

## 1. Things the session log does not show

RuleReceipt reads the agent's saved session log. Anything that never reaches that log is
invisible to it.

| Gap | What it means for you |
|---|---|
| **Commands run outside the session** (another terminal, CI, a teammate) | "Tests ran" can only be confirmed if they ran inside the session. Otherwise the answer is Can't tell. |
| **What happens inside scripts** | `npm run release` might push to `main` inside the script. RuleReceipt sees the script being started, not what it did. |
| **Clicks on Claude Code's permission prompt** | Clicking "Yes" leaves no trace in the log. So "never push without asking" gives **Can't tell**, not Broken, when a prompt could have been shown. It says Broken only when no prompt was possible (bypassPermissions, dontAsk or auto mode, or the command is on your allow list). |
| **Delete / `rm` / `drop` are not bound to a rule's subject** | A "never wipe the production database" rule cannot tell a real DB wipe from a `rm -rf /tmp/scratch`. So delete-style approval rules are **Can't tell**, never Broken; only push/commit/PR gates can say Broken. |
| **Calls blocked by Claude Code's own permission rules** | Other projects report that such calls never appear in the transcript. We have not verified this ourselves yet. If true, a blocked attempt is invisible to RuleReceipt. A recorder hook to close this gap is planned. |
| **Code written by shell commands** | Code checks read what was written with Write/Edit. Code written with `sed -i`, `>` or `cat > file` is not read by those checks. |
| **Compaction** | When a long session is summarised, the log continues, but RuleReceipt does not yet split the report into "before" and "after" the summary. |

## 2. Is the log itself trustworthy?

- The report stores a SHA-256 **hash** of the exact session file it read. That proves the
  report matches that file. It is a fingerprint, **not a signature**, and it does **not**
  prove the file wasn't edited before the check ran.
- Anyone (or any agent) with access to your machine can edit a session file. Tamper-evident
  logging is planned; tamper-proof is not a promise we can make for a local tool.
- **The agent can edit the rules it is judged by.** If CLAUDE.md or `.claude/settings.json`
  changed during the session, RuleReceipt does not yet warn you. Planned.

## 3. Which session is checked

- By default RuleReceipt checks the **most recently modified** session for the current
  folder, across Claude Code and Codex.
- With parallel sessions, worktrees or several agents at once, that may not be the one you
  meant. Use `--transcript <path>` to choose.

## 4. Rules it cannot judge well

Measured on 903 public rules files, 2026-09-28:

| | Share of real rules |
|---|---|
| Can get a confident Followed / Broken | about 1 in 9 |
| Found by text search only, usually ends as Can't tell | about 1 in 5 |
| Judgment calls ("keep changes small"), left to you | about 2 in 3 |

Specific limits:

- **English only.** Rules written in other languages are mostly treated as documentation.
  You can include them with `rules --include <handle>`, but they will be judgment calls.
- **Conditions are not evaluated.** "Never run X **when** on main" or "**unless** asked" is
  left to you, not checked, because the tool cannot evaluate the condition reliably.
- **Rules that forbid one thing and require another** in the same sentence are left to you,
  so a literal is never checked against the wrong half.
- **Order rules** ("run tests **before** commit") are not checked as an order yet.
- **Scope rules** ("only change what I asked"), **test-weakening**, and **rules about MCP
  tools** are not checked yet.
- **Wording varies.** Some real rules are missed because of how they are phrased. For
  example, a rule against AI co-author trailers on "commits" (plural) is not yet recognised
  and is left as a judgment call.
- **Rule history comes from git.** Rules added after a session started are skipped only if
  the change was committed. Uncommitted edits are not tracked.
- **Path-scoped rules** (`paths:` / `globs:`) are matched against file paths the session
  read or wrote. Matching errs toward "the rule was loaded", which can mean a rule is
  checked when Claude never actually loaded it — chosen so it can only remove a false
  accusation, never add one.

## 5. Agents

| Agent | Rules files read | Session log read | Live hooks |
|---|---|---|---|
| Claude Code | Yes | Yes | Yes (Stop hook, PreToolUse guard) |
| Codex CLI | Yes | In testing | No |
| Cursor | Yes | No | No |
| GitHub Copilot | Yes | No | No |
| Windsurf | Yes | No | No |
| Gemini CLI / agy | Yes | No | No |

For agents without a readable session log, RuleReceipt can audit the rules file
(`rulereceipt audit`), but it **cannot** say whether those rules were followed.

## 6. Enforcement (hook and guard)

- Hooks **fail open**. If RuleReceipt crashes, times out or can't read something, your
  session continues. That's deliberate: a checker must never lock you out. It also means a
  broken hook stops protecting you without blocking anything.
- The guard blocks only rules it can check for certain (branches, files, commands you
  marked with `rules --forbid`). Everything else is reported afterwards, not blocked.
- For "never push without asking", the guard answers **ask**, so Claude Code shows its
  permission prompt. We have **not yet verified** that this prompt still appears in
  skip-permissions mode on current Claude Code versions.
- An agent with shell access can edit your settings to remove the hooks. RuleReceipt does
  not yet detect this during the session.

## 7. How accurate are the verdicts?

- The rule: **Broken** only from a structured check with evidence; **Followed** only when
  the action was actually performed, not mentioned; everything else is **Can't tell**.
- Measured so far: the public corpus above, against real public Claude Code sessions and a
  few projects checked against their own sessions. Every new Broken from the latest changes
  was checked by hand, and the ones found wrong were fixed (e.g. the delete-gate case above)
  before release.
- **That is not proof of zero errors.** A hand-labelled truth set of real sessions is
  planned; until it exists, treat the accuracy numbers as measured on a limited sample.
- `--llm` asks a model for an opinion on judgment rules. That is an **opinion**, labelled as
  such, never a verdict.

## 8. Network and privacy

Nothing leaves your machine by default. These send data only when you ask:

| Flag | What is sent | Where |
|---|---|---|
| `--llm` | Excerpts of the session and rule text | Anthropic, with your own API key |
| `--share` | Anonymous pass / fail / unclear counts, no rule text | rulereceipt.dev |
| `--telemetry` | A random install ID | rulereceipt.dev |
| `--email` | The report | Your own mail server, with your credentials |
| `wrong` | Nothing. It prints a link **you** choose to open | GitHub, only if you open it |

## 9. Not what this tool is

- Not a security scanner. It does not look for vulnerabilities or malware.
- Not a sandbox or firewall. It cannot stop everything an agent does.
- Not a guarantee of compliance. It never says a session was "compliant", only what it could
  check and what it found.

---

Found a gap that isn't listed here? Open an issue. Gaps we know about are safer than gaps we
don't.
