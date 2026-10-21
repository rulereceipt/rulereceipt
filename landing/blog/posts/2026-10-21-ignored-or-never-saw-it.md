---
title: "Did your agent ignore your rule, or never see it?"
description: "A rule can break two ways: the agent read it and ignored it, or the rule never loaded at all. Those are different problems, and RuleReceipt tells them apart. A break on a rule that never loaded is shown, but not counted as a violation."
date: 2026-10-21
chapter: "Chapter 2: ignored, or never saw it?"
slug: ignored-or-never-saw-it
draft: false
ogImage: /media/rulereceipt-3-catches-poster.png
---

There are two very different reasons an agent breaks a rule you wrote down.

The first one is the one everybody pictures: the rule was right there in context, the agent read it, and it did the thing anyway. That is the agent ignoring you.

The second one is quieter: the rule never loaded. The agent never had it in context when it made the edit, so it was never really given the choice. That is not the agent ignoring you. It never saw the rule.

If a tool treats those two the same, it gives you the wrong answer every time the rule never loaded. So RuleReceipt keeps them apart.

## Why a rule goes missing

Rules do not only live in the top-level `CLAUDE.md`. A lot of teams put a smaller rules file deeper in the tree, next to the code it governs: `src/payments/CLAUDE.md` with one line about the billing code, `infra/CLAUDE.md` with one line about the cluster. Those nested files only load when the agent actually opens something in that folder.

Two things routinely stop that from happening:

1. **Compaction.** Long sessions get compacted to save context. The summary that survives may not carry a nested rule that loaded an hour ago. After the compaction, the rule is gone from context, even though it loaded earlier.
2. **How the file was read.** Whether reading a nested rules file actually loads it depends on your Claude Code version. This is tracked upstream as [issue #90450](https://github.com/anthropics/claude-code/issues/90450). In older versions a shell read loaded nothing. From 2.1.293 a plain single-file read loads the nested rule, but only with no pipe, no redirect, no chain. The exact table was measured against Claude Code 2.1.296 by a developer, yishait-tailor, using an InstructionsLoaded hook as ground truth: `cat`, `head`, `tail`, `nl`, `bat`, `sed -n`, `grep` and `rg` load it, but a pipe, a `2>/dev/null` redirect, a `grep -r`, or a `cd dir && cat file` load nothing.

This is not an edge case. On the same issue, another developer, miguelbacalhau, went through 1,749 real Claude Code transcripts and checked each change against the rules that should have covered it. Of the edits to files a rule covered, 67 percent were made with at least one matching rule not loaded. For writes of a new file it was 78 percent. The quiet case is the common one.

RuleReceipt reads the version your session recorded and applies the matching table, so it does not accuse an agent of ignoring a rule its version never loaded from that kind of read.

## What the receipt looks like

Here is a demo session. It is **demo data**, not a real incident: a small project with a nested rule.

```
# src/payments/CLAUDE.md
## 1. Never edit files under `src/payments/` without approval
```

The session was recorded on Claude Code 2.1.288, it got compacted partway through, and after the compaction the agent edited `src/payments/charge.ts`. It never opened the nested rules file first. This is the full, real output:

```
RuleReceipt · 2 rules checked
────────────────────────────────────────

⚠ Never loaded (1)
  advisory, not a verdict — a file these rules cover was edited, with no record the rule was loaded first
  • Never edit files under `src/payments/` without approval

Checked — observable rules (2)

Rule not visible (not a violation) (1)
✕ FAIL    Rule 1 (project) — Never edit files under `src/payments/` without approval
  ↳ ~/code/web-api/src/payments/CLAUDE.md:3
  evidence: "src/payments/" was actually modified: Edit on src/payments/charge.ts
  not a violation: the agent never had this rule in context at that moment.
  fix: The rules file was in context earlier but not after the last compaction. Add a post-compaction hook (SessionStart:compact) that re-injects your rules.

Couldn't tell (1)
? UNCLEAR Rule 1 (project) — Run `npm test` before you push
  ↳ ~/code/web-api/CLAUDE.md:3
  evidence: required pattern "npm test" was not actually run this session — can't tell if the rule didn't apply, or applied and was skipped

────────────────────────────────────────
0 followed · 0 not followed · 1 rule not visible · 1 couldn't tell
```

<figure>
<img src="/media/blog/02-never-loaded-report.png" alt="RuleReceipt HTML report for the demo session. Headline: No rule violations found, 1 couldn't be determined. Counts: 0 followed, 0 not followed, 1 rule not visible, 1 couldn't tell. A Never loaded advisory at the top, and a Rule not visible (not a violation) section for the edit to src/payments/charge.ts." />
<figcaption>The same session as a shareable HTML report (demo session). The edit is shown, but filed under "Rule not visible", not counted as a violation.</figcaption>
</figure>

The edit was found. RuleReceipt saw that `src/payments/charge.ts` was modified. But it did not count it as a violation, because the rule was never in context at that moment. It puts the break under "Rule not visible", tells you why, and the tally reads zero not followed.

Now the same edit, the same rule, one thing changed: this session was on 2.1.296 and the agent ran `cat src/payments/CLAUDE.md` before the edit, so the rule loaded. Same check, full output:

```
RuleReceipt · 2 rules checked
────────────────────────────────────────

Checked — observable rules (2)

Not followed (1)
✕ FAIL    Rule 1 (project) — Never edit files under `src/payments/` without approval
  ↳ ~/code/web-api/src/payments/CLAUDE.md:3
  evidence: "src/payments/" was actually modified: Edit on src/payments/charge.ts
     why it broke:
       your rules file was in context before this.

Couldn't tell (1)
? UNCLEAR Rule 1 (project) — Run `npm test` before you push
  ↳ ~/code/web-api/CLAUDE.md:3
  evidence: required pattern "npm test" was not actually run this session — can't tell if the rule didn't apply, or applied and was skipped

────────────────────────────────────────
0 followed · 1 not followed · 1 couldn't tell
```

This time it is a plain FAIL. One not followed. The rule was in context before the edit, the agent had it, and it edited anyway. Same edit, same rule. The only difference is whether the agent saw it, and that is the difference between a violation and a note.

## The honest part

"Not visible" is a possible explanation, not a verdict of innocence. A transcript cannot show you context it never recorded, so RuleReceipt says what it can prove and no more: the file was edited, the rule has no load record, draw your own conclusion. And if a nested folder was never touched at all, that rule is reported "didn't apply", not a failure. A rule that had nothing to govern this session is not a miss.

Point it at your last session and see which of your rules actually loaded:

```
npx rulereceipt check
```

(I built this.)
