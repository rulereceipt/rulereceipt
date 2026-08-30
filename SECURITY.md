# Security

## Reporting a vulnerability

Please report security issues privately, not as a public issue.

- Use GitHub's [private vulnerability reporting](https://github.com/rulereceipt/rulereceipt/security/advisories/new) (preferred), or
- Email hello@rulereceipt.dev

Please include what you found, how to reproduce it, and what an attacker
could actually do with it. You'll get a reply acknowledging the report.

## What this tool touches on your machine

Worth knowing when assessing risk:

- It **reads** your CLAUDE.md / AGENTS.md files and your local Claude Code
  session transcripts. It does not write to them.
- It never modifies `.claude/settings.json` and installs no hooks.
- It writes only to `~/.rulereceipt/` (its own config and, if you opt in,
  a random telemetry ID), with owner-only permissions.
- Plain `rulereceipt check` makes no network calls. `--llm`, `--share`,
  and `--telemetry` are separate, off-by-default opt-ins.

## Known limitation, stated plainly

The session transcript is a file on your own machine. Anyone with access
to it can edit it before a check runs, and the report would faithfully
describe the edited file. The hash in a report proves the report matches
the file it read — not that the file is an unmodified record of the
session. This is not currently tamper-evident against someone
deliberately covering their tracks.
