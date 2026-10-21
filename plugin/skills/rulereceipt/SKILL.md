---
name: rulereceipt
description: Check whether this coding session followed the project's own CLAUDE.md / AGENTS.md rules. Use after finishing work, or when the user asks "did you follow my rules", "what did you break", "check the rules", "audit my rules", or whether a specific rule was kept. Reads the finished transcript locally and reports each rule as followed, broken (with the quoted line as proof), or needs-human-judgment. It reports after the fact; it does not make the model obey and it blocks nothing.
---

# RuleReceipt

RuleReceipt reads the finished session transcript against the project's own
`CLAUDE.md` / `AGENTS.md` and reports, per rule: **followed**, **broken** (with the
exact quoted line as proof), or **needs human judgment**. It runs locally and makes no
network calls. It reports what happened; it does not make the agent obey, and on its
own it blocks nothing.

## What to run

From the project directory, run:

```
npx rulereceipt check
```

Report **only** what the tool prints — do not add, soften, invent, or re-grade any
verdict. Other read-only subcommands, when the user asks for them:

- `npx rulereceipt audit` — score the rules files themselves (no session needed):
  which files load, how much is checkable vs judgment vs documentation.
- `npx rulereceipt why "<rule text>"` (or `--all`) — where one rule lives, whether the
  agent loads it, whether it is mechanically checkable.
- `npx rulereceipt health` — lint rules against each other (contradictions, duplicates;
  advisory only).

## Rules for reporting

- Quote the tool's verdicts verbatim; a broken rule comes with the line the tool quoted
  as proof. Do not claim a rule passed or failed beyond what it printed.
- A "needs human judgment" rule is **not** a FAIL — present it as a judgment call for
  the human, never as a pass or a violation.
- Never pass `--llm`. `--llm` is an opt-in model *opinion* (uses the user's own
  Anthropic/local key and sends the rules out); it is never a verdict and never blocks.
  Run it only if the user explicitly asks for a model's opinion.
- Do not install hooks, start a server, or upload anything. RuleReceipt detects and
  reports, and blocks only a narrow file/branch subset via an opt-in guard the user
  must wire up themselves. It does not force the model to comply — say so if asked.
