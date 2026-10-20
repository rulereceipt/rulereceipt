---
title: "Ignored, or never saw it?"
description: "A rule can be broken two ways: the agent read it and ignored it, or it never loaded the rule at all. RuleReceipt tells those apart — and 'never loaded' is its own, quieter finding."
date: 2026-10-25
chapter: "Chapter 2 — Ignored or never saw it?"
slug: ignored-or-never-saw-it
draft: true
ogImage: /media/rulereceipt-3-catches-poster.png
---

<!-- DRAFT — outline + real evidence. Not for publish until reviewed. -->

## The pain
Long sessions get compacted. Big `CLAUDE.md` files get truncated. The agent edits a file your rule covers — but there's no record the rule was ever in context. Was it ignored, or never seen?

## What RuleReceipt does
- A broken rule where the log *shows* the forbidden action → **FAIL**.
- A covered file edited with **no record the rule loaded first** → a separate **"Never loaded"** finding, listed above the checked rules. It is not a FAIL — it's a reason the agent may never have had the rule.
- A rule whose path scope was never touched → "didn't apply," not "never loaded."

## Exact rule / evidence (demo data)
- Rule: `Never edit files under src/payments/ without approval.`
- Session: `Edit src/payments/charge.ts`, and the transcript never shows the rules file being read/attached before it.
- Receipt: under **⚠ Never loaded** — "edited a covered file with no record the rule was loaded first."

## Honesty note
"Never loaded" is a *possible* explanation, not proof the agent was blameless — the transcript simply can't show context it doesn't record. Stated plainly, never as a verdict.

## CTA
`npx rulereceipt check` · [rulereceipt.dev](https://rulereceipt.dev)
