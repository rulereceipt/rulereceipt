---
title: "Set up in 30 seconds"
description: "No account, no upload, no config. One command reads your last session against your rules. A second, optional command turns on blocking — and shows you exactly what it changes first."
date: 2026-11-22
chapter: "Chapter 6 — Set up in 30 seconds"
slug: set-up-in-30-seconds
draft: true
ogImage: /media/rulereceipt-3-catches-poster.png
---

<!-- DRAFT — outline + real evidence. Not for publish until reviewed. -->

## The pain
Most "governance" tools want a login, a dashboard, and your transcripts on their server before they tell you anything. For a local-first check, that's backwards.

## What RuleReceipt does
- `npx rulereceipt check` — reads the finished session against your `CLAUDE.md`/`AGENTS.md`, prints the receipt. Zero network calls, nothing uploaded.
- `rulereceipt protect` — optional. Installs the narrow file/branch guard, but **shows you the exact diff it will add and asks first**; undo anytime.
- `rulereceipt check --html` / `--timeline` — the same receipt as a shareable report.

## Exact flow / evidence (demo data)
- `check` → the receipt from Chapter 1.
- `protect` → prints the hook block it would add, waits for yes, nothing written until you confirm.

## Honesty note
`check` detects and reports — it does not block. Blocking is only the opt-in `protect` guard, and only for the narrow subset it can enforce. It never makes the model obey.

## CTA
`npx rulereceipt check` · [rulereceipt.dev](https://rulereceipt.dev)
