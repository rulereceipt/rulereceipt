# RuleReceipt skill (shared Agent Skills format)

`rulereceipt/SKILL.md` is one skill in the open [Agent Skills](https://agentskills.io/specification)
format (`name` + `description` frontmatter). It tells the agent to run
`npx rulereceipt check` and report the result verbatim. It installs **no hooks**,
never passes `--llm`, starts no server, and uploads nothing — it reports after the
fact and blocks nothing.

Prerequisite: Node.js (the skill runs `npx rulereceipt check`).

## Install

The one file works across agents; only the folder it lives in differs. The widest
common location is `.agents/skills/` — Codex, Cursor, Antigravity, Gemini CLI,
OpenCode, Devin and GitHub Copilot CLI all read it.

| Agent | Drop `rulereceipt/SKILL.md` into |
|---|---|
| Claude Code | the plugin (`/plugin marketplace add rulereceipt/rulereceipt` → `/plugin install rulereceipt`), or `~/.claude/skills/rulereceipt/` |
| OpenAI Codex | `.agents/skills/rulereceipt/` (repo) or `~/.agents/skills/rulereceipt/` |
| Cursor | `.cursor/skills/rulereceipt/` or `.agents/skills/rulereceipt/` |
| GitHub Copilot CLI | `copilot skill add ./skills/rulereceipt`, or `.github/skills/` / `.agents/skills/` |
| Google Antigravity | bundle in a plugin's `skills/` (`.agents/skills/`) |
| Gemini CLI | `.gemini/skills/rulereceipt/` (or `.agents/skills/`) |
| OpenCode | `.opencode/skills/`, `.claude/skills/`, or `.agents/skills/` |
| Cline | `.cline/skills/rulereceipt/` (Skills is experimental — enable in Settings → Features) |
| Devin | `.agents/skills/rulereceipt/` (also scans `.devin/`, `.claude/`, `.github/`, `.cognition/`, `.windsurf/` skills) |

Fastest cross-agent install once published: `npx skills add rulereceipt/rulereceipt`
(drops the skill into `.agents/skills/`).

## This is a skill, not a hook

A skill is read-only guidance the agent chooses to follow. It does not force the
model to obey, and it cannot block a command. If you want RuleReceipt to actually
*stop* a bad push or a forbidden file edit, wire up the CLI's opt-in guard yourself
(`rulereceipt guard` as a PreToolUse hook, `rulereceipt hook` as a Stop hook) — the
skill deliberately does not install those for you.

The canonical copy lives here; the Claude Code plugin copy at
`plugin/skills/rulereceipt/SKILL.md` is kept byte-identical (enforced by
`tests/skillParity.test.ts`).
