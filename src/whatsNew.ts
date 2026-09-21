import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Release {
  version: string;
  highlights: string[];
}

/**
 * User-facing release highlights, newest first.
 *
 * This is NOT the internal CHANGELOG (developer/business-facing, never
 * shipped). It is the short, plain "here is what got better" note a user
 * sees once, the first time they run a new version. Add ONE entry at the
 * top on each release: what changed, in a sentence, honest, no marketing.
 *
 * The whole point: someone who bounced off an early version sees the tool
 * is improving and comes back. So keep it truthful — a highlight that
 * overstates is the exact failure this tool exists to catch.
 */
export const RELEASES: Release[] = [
  {
    version: "0.1.46",
    highlights: [
      "Run RuleReceipt in CI: `--json` output, `verify-receipt`, and a GitHub Action (uses: rulereceipt/rulereceipt).",
      "`rulereceipt init` for guided setup, and per-rule warnings via .rulereceipt/config.json so CI gates on what matters.",
      "Opt-in `--check-updates` to hear when a new version ships.",
    ],
  },
  { version: "0.1.45", highlights: ["The tool now shows what's improved since you last ran it, like this note."] },
  { version: "0.1.44", highlights: ["The report now offers to install enforcement, but only when a rule was actually broken."] },
  { version: "0.1.43", highlights: ["New check: a claim to have read or verified something, with nothing in the session behind it."] },
  { version: "0.1.41", highlights: ["Emoji rules are checked properly now (Unicode properties, not a hand-written list)."] },
  { version: "0.1.39", highlights: ["You can mark which clause in a rule is the actual prohibition, so only that blocks."] },
  { version: "0.1.36", highlights: ["Enforcement arrives: the tool can act on a broken rule with a hook, not just report it."] },
];

function stateDir(): string {
  return join(homedir(), ".rulereceipt");
}

function lastSeenPath(): string {
  return join(stateDir(), "last-seen-version");
}

export function readLastSeen(): string | null {
  try {
    const v = readFileSync(lastSeenPath(), "utf-8").trim();
    return v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

export function writeLastSeen(version: string): void {
  try {
    const dir = stateDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(lastSeenPath(), version, "utf-8");
  } catch {
    // best-effort; a run that cannot persist this just shows the note again
  }
}

/**
 * Numeric dotted-version compare: <0 if a<b, 0 if equal, >0 if a>b.
 * Numeric per segment, so 0.1.9 < 0.1.10 (not lexical). Junk gives 0, which
 * makes the caller show nothing rather than guess.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10));
  const pb = b.split(".").map((n) => parseInt(n, 10));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/**
 * Releases strictly newer than lastSeen and no newer than current, newest
 * first. A null lastSeen (first run ever) yields nothing on purpose: a
 * first-timer should see their report, not a changelog.
 */
export function highlightsBetween(
  lastSeen: string | null,
  current: string,
  releases: Release[] = RELEASES
): Release[] {
  if (!lastSeen) return [];
  return releases.filter(
    (r) => compareVersions(r.version, lastSeen) > 0 && compareVersions(r.version, current) <= 0
  );
}

export function renderWhatsNew(releases: Release[], current: string): string {
  const lines: string[] = [];
  lines.push(`\n✨ What's new since you last ran rulereceipt (you're on v${current}):`);
  for (const r of releases) {
    for (const h of r.highlights) {
      lines.push(`  • v${r.version}  ${h}`);
    }
  }
  lines.push(`\nThis note shows once per update. To stay current: npx rulereceipt@latest`);
  return lines.join("\n");
}

/**
 * Prints the "what's new" note once per new version, then records the
 * current version so it never repeats for that version.
 *
 * Fails open, always: any error here must never affect the report the user
 * actually ran for, and there is no network call — the notes ship inside
 * the package, so the tool stays true to "nothing leaves your machine".
 */
export function maybeShowWhatsNew(current: string, log: (s: string) => void = console.log): void {
  try {
    const lastSeen = readLastSeen();
    const news = highlightsBetween(lastSeen, current, RELEASES);
    if (news.length > 0) log(renderWhatsNew(news, current));
    // Record current even on the first run and even when nothing showed, so
    // the next update is measured from here.
    if (lastSeen !== current) writeLastSeen(current);
  } catch {
    // never let a footer break the run
  }
}
