---
title: "How often is it wrong?"
description: "A rule-checker that accuses you wrongly is worse than none. Here's the false-FAIL rate, measured on real rules files and dated — including the number I don't love."
date: 2026-11-15
chapter: "Chapter 5 — How often am I wrong"
slug: how-often-am-i-wrong
draft: true
ogImage: /media/rulereceipt-3-catches-poster.png
---

<!-- DRAFT — outline + real evidence. Not for publish until reviewed. -->

## The pain
Any checker's real question isn't "what can it catch" — it's "how often does it cry wolf." A false FAIL on your own correct work and you stop trusting it by Tuesday.

## What RuleReceipt does
Measures its own false-FAIL rate and publishes it, dated:
- **0 false FAILs** on the frozen test sets.
- On **559 real rules files × 5 sessions**, at most **0.4%** of reports showed a FAIL we count as wrong (**Oct 18, 2026**), down from **2.9%** (**Sep 21, 2026**).
- Every one of those was hand-checked: a real action matched against a rule from a different project (the measured ceiling), not a misread.

## Honesty note
0.4% is a ceiling, not zero. The remaining hits are mechanically-correct ("you did push to main") on sessions where that was fine for that project — a rule-scope limitation, not a misread. Numbers always carry their date; no "0 false accusations" without the corpus number beside it.

## CTA
`npx rulereceipt check` · [rulereceipt.dev](https://rulereceipt.dev)
