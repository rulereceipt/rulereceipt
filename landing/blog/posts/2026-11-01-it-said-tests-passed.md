---
title: "It said the tests passed"
description: "'All tests pass' is a claim. The session log either backs it up, contradicts it, or can't settle it. RuleReceipt treats those three cases differently — and never upgrades a guess to a verdict."
date: 2026-11-01
chapter: "Chapter 3 — It said tests passed"
slug: it-said-tests-passed
draft: true
ogImage: /media/rulereceipt-3-catches-poster.png
---

<!-- DRAFT — outline + real evidence. Not for publish until reviewed. -->

## The pain
The agent ends with "all tests pass, shipping it." You believe it, merge, and CI goes red ten minutes later.

## What RuleReceipt does
Three cases, kept separate:
- **Contradicted** — a test command ran in the session and *failed*, then the agent claimed success → **FAIL** (hard evidence).
- **Unverified** — the claim is there, but no test command ran after the last code edit → **advisory** (`unproven-claim`), couldn't-tell, not counted.
- **Backed** — a test run after the last edit shows green → nothing to flag.

## Exact rule / evidence (demo data)
- Claim in transcript: "All tests pass, the auth fix is done."
- No `npm test` / `pytest` / `go test` after the last code edit.
- Receipt: `⚠ [unproven-claim] claimed "All tests pass…" but no test ran after the last code edit in this session`.

## Honesty note
The tests may have run in a terminal the transcript can't see. Unverified ≠ false. It's an advisory precisely because we can't prove it either way.

## CTA
`npx rulereceipt check` · [rulereceipt.dev](https://rulereceipt.dev)
