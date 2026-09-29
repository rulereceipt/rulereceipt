# Rollback runbook

What to do if a published release is bad. The npm registry read-side lags a few
minutes behind a publish, so give any command below time to propagate before
judging it.

## How publishing works here (read this first)

Publishing is **GitHub Actions only** — there is no npm token on any laptop
(`npm whoami` returns E401 by design). A new version is published by pushing a
`v<x.y.z>` git tag: `.github/workflows/publish.yml` triggers on `v*.*.*`, runs
`npm ci && npm run build`, and publishes with `npm publish --provenance --access
public` via npm **trusted publishing (OIDC)**. The tag's version must equal
`package.json`'s version or the publish is wrong/failing. Publishing always goes
to the **`latest`** dist-tag (there is no staged `next` tag in this workflow).

**Rollback commands below are the exception:** `npm dist-tag` and `npm deprecate`
are NOT run by the workflow, so they need a local login first:

```bash
npm login          # authenticate as the rulereceipt npm account (personal, NOT office)
npm whoami         # confirm it says the rulereceipt account before touching dist-tags
```

## If 0.1.75 is bad — exact steps

Published 2026-09-30. Last known-good before it: **0.1.74** (but 0.1.74 has the
session-discovery bug for dotted paths and the false-accusation classes 0.1.75
fixed — rolling back to it trades bugs, so prefer roll-forward to a 0.1.76 patch).

If you must roll `latest` back right now while a fix is prepared:

```bash
npm login                                        # as the rulereceipt account
npm dist-tag add rulereceipt@0.1.74 latest       # point latest back at 0.1.74
npm deprecate rulereceipt@0.1.75 "Regression in 0.1.75: <one line>. Use 0.1.74, fix incoming."
npm dist-tag ls rulereceipt                       # confirm latest -> 0.1.74
```

Then roll forward: fix on main (red-first test), bump to 0.1.76, push a `v0.1.76`
tag (Actions publishes it to `latest`), and undeprecate is not needed — 0.1.76
supersedes. Do NOT `npm unpublish` (see below).

## First: decide roll forward vs roll back

**Prefer rolling forward.** Ship a fixed patch rather than repointing `latest` at
an older version — older versions carry their own known bugs. In particular, do
**not** roll `latest` back to **0.1.74 or earlier**: those have the
false-accusation classes fixed in 0.1.75 and the session-discovery bug (projects
with a dot/underscore/space in their path find zero sessions). Rolling back to
them trades one problem for a worse one.

Roll back only when a fix will take longer than you can leave the bad version as
`latest`, and only to the newest version you have actually verified is good.

## Repoint `latest` to a known-good version (temporary)

```bash
# See what is out there and which one `latest` points at:
npm view rulereceipt versions --json
npm view rulereceipt dist-tags

# Point latest at a specific KNOWN-GOOD version (example only — use a verified one):
npm dist-tag add rulereceipt@<good-version> latest
npm dist-tag ls rulereceipt        # confirm latest moved
```

This changes what `npm i rulereceipt` / `npx rulereceipt@latest` resolve to,
without unpublishing anything.

## Mark a bad version so people are warned

```bash
npm deprecate rulereceipt@<bad-version> "Known issue: <one line>. Use <good-version> instead."
```

Deprecation shows a warning on install but leaves the version installable (so
anyone pinned to it is not broken). Prefer this over unpublish.

## Do NOT unpublish to fix a bug

Unpublish is almost never the right tool here, and it has bitten this project
before (see CLAUDE.md — every publish pushes the unpublish window further out,
and mirrors re-pull each release). Repoint `latest` and deprecate instead.

## Roll forward: publish a fix

1. Fix on `main`, with a red-first test that reproduces the bad behaviour.
2. Full suite green, `tsc` clean, `eslint` clean.
3. Pack the tarball and run the reviewer's `validate-release.sh <tarball>` — it must
   pass, including the dot/underscore/space paths, monorepo, @AGENTS.md import.
4. Clean-room install from the tarball, zero-network trap, `selftest`.
5. Bump the patch version, tag `v<x.y.z>`, push the tag — GitHub Actions publishes
   with npm provenance (there is no local publish token to steal or misuse).
6. `npm dist-tag ls rulereceipt` to confirm `latest` moved to the new version.
7. If you had repointed `latest` to an older good version, it now advances to the fix.

## After any rollback or roll-forward

- Say what happened in the release notes and thank whoever reported it, by name.
- Add the failure to KNOWN-GAPS or a regression test so it cannot come back silently.
