---
title: "Not every rule can be checked"
description: "Some rules are observable from the log. Some need a human to judge. RuleReceipt splits them — 'Checked' vs 'Not checked' — and never pretends to grade the ones it can't."
date: 2026-11-08
chapter: "Chapter 4 — Not every rule can be checked"
slug: not-every-rule-can-be-checked
draft: true
ogImage: /media/rulereceipt-3-catches-poster.png
---

<!-- DRAFT — outline + real evidence. Not for publish until reviewed. -->

## The pain
"Write clean code." "Be concise." "Prefer simple solutions." Real rules — but nothing in a transcript proves or disproves them. A tool that scored them would be making numbers up.

## What RuleReceipt does
Every rule is routed to one of two groups:
- **Checked — observable rules**: branch/file/command/claim rules it can decide from the log (followed / not followed).
- **Not checked — needs your judgment**: style and intent rules, collapsed by default, left for a human — or for `rulereceipt check --llm`, which gives a **labelled opinion only** and can never FAIL a build.

## Exact rule / evidence (demo data)
- Rule: `Keep functions small and focused.`
- Receipt: under **Not checked — needs your judgment** — "nothing in the transcript settles this; a human (or --llm) decides."

## Honesty note
The split is the honesty. The point isn't to grade everything — it's to be clear about what was actually checked and what wasn't, so a clean receipt never overclaims.

## CTA
`npx rulereceipt check` · [rulereceipt.dev](https://rulereceipt.dev)
