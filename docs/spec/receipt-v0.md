# Rule Receipt format — v0 (draft)

**Status: draft, v0. Comments welcome** (open an issue). This documents the JSON
that `rulereceipt check --export` already emits, so that any agent or CI tool can
produce or read a "rule receipt" without depending on RuleReceipt itself.

A *rule receipt* is a small, shareable record of one session checked against one
set of written rules: for each rule, the verdict and the quoted evidence behind
it. It is **not** a transcript. It carries only what a verdict already shows.

This v0 describes schema version `1` (the `schema` field below). The format is
versioned; see [Versioning](#versioning).

## Design rules (what a conforming emitter must honour)

1. **Local by default.** A receipt is produced on the user's machine. Nothing is
   uploaded to produce one.
2. **No transcript, no absolute paths.** A receipt never contains the raw session,
   and `project` is a basename, never an absolute local path.
3. **Evidence is redacted before it leaves.** Obvious secrets, the home path and
   emails are masked in `evidence` (the same masking `rulereceipt wrong` uses).
4. **A verdict is backed by evidence or it is `UNCLEAR`.** `FAIL` and `PASS` are
   only emitted when the session actually shows the action; everything else is
   `UNCLEAR`. An emitter must not guess.
5. **A rule that was not in context is not a break.** See `notVisible` below.

## Top-level object

```json
{
  "tool": "rulereceipt",
  "kind": "export",
  "schema": 1,
  "version": "0.1.109",
  "dev": "jane",
  "project": "my-repo",
  "date": "2026-10-16",
  "summary": { "total": 12, "pass": 2, "fail": 1, "unclear": 9 },
  "rules": [ /* see below */ ]
}
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `tool` | string | yes | Producer id. `"rulereceipt"` for receipts this CLI emits; another emitter MAY use its own id. A reader keys on `kind`, not `tool`. |
| `kind` | `"export"` | yes | Marks the object as a rule receipt. A tolerant reader requires `kind === "export"` and an array `rules`. |
| `schema` | integer | yes | Format version. `1` for this spec. |
| `version` | string | yes | The emitter's own version (free-form), for provenance. |
| `dev` | string | yes | Who produced it — editable; defaults to the git user name. `"unknown"` if unset. |
| `project` | string | yes | Project **basename only**, never an absolute path. |
| `date` | string | yes | ISO date, day precision (`YYYY-MM-DD`) — enough for a trend. |
| `summary` | object | yes | `{ total, pass, fail, unclear }`, all integers. `fail` counts only **broken-and-visible** rules (a `notVisible` FAIL is excluded). |
| `rules` | array | yes | One entry per rule; see next table. |

## `rules[]` entry

```json
{ "title": "Never push to main", "source": "project", "status": "FAIL",
  "evidence": "git push origin main", "notVisible": false }
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `title` | string | yes | The rule text (redacted). |
| `source` | `"global"` \| `"project"` | yes | Where the rule lived — a user/global rules file, or the project's. |
| `status` | `"PASS"` \| `"FAIL"` \| `"UNCLEAR"` | yes | The verdict. These three are the whole vocabulary. |
| `evidence` | string | yes | The quoted line from the session that backs the verdict (redacted). May be empty for `UNCLEAR`. |
| `notVisible` | boolean | no | When `true`, the rule *would* have been broken but was never in the session's context, so it is **not** counted as broken. Omitted when false. |

### Status vocabulary

- **`PASS`** — the session shows the required action actually performed (not just
  mentioned). A mention, a search or a plan does not earn `PASS`.
- **`FAIL`** — the session shows the forbidden action, or a missing required step,
  for certain, from a structured check with the quoted evidence. Never a guess.
- **`UNCLEAR`** — the default. Anything the receipt cannot settle from evidence,
  including judgment-only rules.

A conforming reader MUST treat any unknown `status` value as `UNCLEAR`, and MUST
NOT count a `notVisible` entry as broken.

## Versioning

- `schema` is a single integer. A breaking change to field names, types or
  meaning increments it.
- Readers SHOULD accept any `schema` they understand and ignore unknown extra
  fields (forward-compatible). A reader that does not recognise `schema` SHOULD
  say so rather than mis-parse.
- This document describes `schema: 1`. Later versions get their own section.

## What is deliberately NOT in a receipt

The raw transcript; absolute paths; unmasked secrets; anything time-series or
cross-repo. A receipt is one session, one rules set, point-in-time. Combining
receipts over time or across repos is a separate concern and is not part of this
format.

## Reference

The emitter and the tolerant reader in this repository are
`buildTeamExport` / `parseExport` in `src/teamExport.ts`; `EXPORT_SCHEMA` there is
the `schema` value. A conformance test (`tests/receiptSpecV0.test.ts`) checks that
the emitted object matches this document.
