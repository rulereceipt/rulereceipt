---
description: Check this machine/project setup — which agents can be read, what's checkable, and any problems
---
Run `npx rulereceipt@0.1.120 doctor` in the current project and show the result: every
Claude Code hook and VS Code auto-task found (flagging anything suspicious), and
with `--capabilities` the capability matrix — which agents' sessions can be read,
what each check inspects, and what the tool cannot catch. Report only what the tool
prints; do not add or infer capabilities it does not claim.
