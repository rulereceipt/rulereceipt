---
title: "Hooks block, receipts prove"
description: "A hook stops what it can, in-flight. A receipt proves, after the fact, what actually happened — including when the hook errored or got bypassed. You want both, doing different jobs."
date: 2026-11-29
chapter: "Chapter 7 — Hooks block, receipts prove"
slug: hooks-block-receipts-prove
draft: true
ogImage: /media/rulereceipt-3-catches-poster.png
---

<!-- DRAFT — outline + real evidence. Not for publish until reviewed. -->

## The pain
Hooks are great until one errors, gets skipped, or doesn't cover the case. If the only thing standing between you and a bad push is a hook, a silent hook failure is a silent gap.

## What RuleReceipt does
Two layers, different jobs:
- **Guard (hook)** — `rulereceipt protect` blocks the narrow file/branch subset in-flight, before the action lands.
- **Receipt (check)** — reads the whole finished session afterward and proves what happened, hook or no hook. If a guard errored or was bypassed and the action went through, the receipt still shows the FAIL with its evidence line.

## Exact flow / evidence (demo data)
- Guard installed, but a `git push origin main` still lands (hook errored).
- `rulereceipt check` → `✕ FAIL Never push to main — git push origin main`. The receipt catches what the live block missed.

## Honesty note
Neither layer makes the model obey. The guard blocks a narrow set; the receipt reports everything but changes nothing on its own. Defense in depth, stated as exactly that.

## CTA
`npx rulereceipt check` · [rulereceipt.dev](https://rulereceipt.dev)
