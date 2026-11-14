---
description: Write a shareable single-file HTML report of this session's rule check and open it
---
Run `npx rulereceipt@0.1.120 check --html` in the current project. It writes a single-file
HTML report (verdicts + the quoted evidence line, no transcript, no network calls)
and prints the path it wrote. Tell the user that path and offer to open it (e.g.
`open <path>` on macOS). Report only what the tool output says — the same verdicts
as `/rulereceipt:check`, just in a shareable file. Do not edit the rules files and
do not install anything.
