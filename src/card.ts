/**
 * `rulereceipt card` — a shareable image and pre-filled share links, built from
 * history-mode counts. This is the "share it" step: someone runs RuleReceipt,
 * sees their agent's mistakes, fixes them with `protect`, and posts the card.
 *
 * Privacy is the whole point of it being shareable: by default the card and the
 * share text carry ONLY counts — never code, file paths, or rule text. A rule's
 * name appears only when the user passes `--show-rules`, and even then only in
 * the copy-text, never the image. Nothing is posted automatically and nothing
 * is uploaded; the links open a compose window the user chooses to send.
 */

export interface CardData {
  broken: number;
  followed: number;
  judgment: number;
  sessions: number;
  days: number;
  /** "Claude" when the sessions are all Claude Code, else "the agent". */
  who: string;
  /** Titles of the broken rules — only used with --show-rules. */
  brokenTitles?: string[];
}

const SITE = "rulereceipt.dev";

/** The share caption. Counts only, unless showRules adds the broken rule names. */
export function shareText(d: CardData, showRules = false): string {
  // A single dropped session (the browser demo) has no "over N days" span, so
  // it gets a "this session" caption rather than the history-mode one.
  const single = d.sessions === 1;
  const base = single
    ? d.broken > 0
      ? `${d.who} broke my written rules ${d.broken} time${d.broken === 1 ? "" : "s"} in this session — now it can't.`
      : `RuleReceipt checked one of my agent's sessions against my written rules: ${d.broken} broken.`
    : d.broken > 0
      ? `${d.who} broke my written rules ${d.broken} time${d.broken === 1 ? "" : "s"} in ${d.days} days (${d.sessions} sessions) — now it can't.`
      : `RuleReceipt checked ${d.sessions} of my agent sessions over ${d.days} days against my written rules: ${d.broken} broken.`;
  const tail = `Checked with RuleReceipt — runs locally, nothing uploaded. ${SITE}`;
  if (showRules && d.broken > 0 && d.brokenTitles && d.brokenTitles.length > 0) {
    const list = d.brokenTitles.slice(0, 3).map((t) => `“${t.replace(/\s+/g, " ").trim().slice(0, 50)}”`).join(", ");
    return `${base}\nBroke: ${list}.\n${tail}`;
  }
  return `${base}\n${tail}`;
}

export interface ShareLinks {
  x: string;
  linkedin: string;
  bluesky: string;
  reddit: string;
}

/** Compose-window links for each network. No auth, no posting — the user sends it. */
export function shareLinks(text: string): ShareLinks {
  const t = encodeURIComponent(text);
  const url = encodeURIComponent(`https://${SITE}`);
  const title = encodeURIComponent(text.split("\n")[0]);
  return {
    x: `https://twitter.com/intent/tweet?text=${t}`,
    // LinkedIn's offsite share only takes a URL; the caption is added by the user.
    linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${url}`,
    bluesky: `https://bsky.app/intent/compose?text=${t}`,
    reddit: `https://www.reddit.com/submit?title=${title}&url=${url}`,
  };
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** A self-contained SVG card. Counts only — never rule text, paths or code. */
export function cardSvg(d: CardData): string {
  const headline = d.broken > 0 ? `${d.who} broke your rules ${d.broken}×` : `0 rules broken`;
  const sub = d.days > 0
    ? `${d.sessions} session${d.sessions === 1 ? "" : "s"} · last ${d.days} days`
    : `${d.sessions} session${d.sessions === 1 ? "" : "s"}`;
  const stats = `${d.followed} followed · ${d.judgment} need judgment`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="418" viewBox="0 0 800 418" role="img" aria-label="RuleReceipt summary">
  <rect width="800" height="418" fill="#0b0d10"/>
  <rect x="0" y="0" width="800" height="6" fill="${d.broken > 0 ? "#e5534b" : "#3fb950"}"/>
  <text x="56" y="86" fill="#8b949e" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="20">RuleReceipt</text>
  <text x="56" y="196" fill="#e6edf3" font-family="-apple-system, Segoe UI, Roboto, sans-serif" font-size="52" font-weight="700">${esc(headline)}</text>
  <text x="56" y="248" fill="#8b949e" font-family="-apple-system, Segoe UI, Roboto, sans-serif" font-size="24">${esc(sub)}</text>
  <text x="56" y="300" fill="#8b949e" font-family="-apple-system, Segoe UI, Roboto, sans-serif" font-size="22">${esc(stats)}</text>
  <text x="56" y="372" fill="#6e7681" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="18">proof from real sessions · local · nothing uploaded · ${SITE}</text>
</svg>`;
}

/** The terminal block: where the image went, the share links, and the copy-text. */
export function renderCardShare(d: CardData, outPath: string, showRules = false): string {
  const text = shareText(d, showRules);
  const links = shareLinks(text);
  const out: string[] = [];
  out.push(`Saved a shareable card to ${outPath} (counts only — no code, paths or rule text).`);
  out.push("");
  out.push("Share it (opens a compose window — nothing is posted for you):");
  out.push(`  X / Twitter  ${links.x}`);
  out.push(`  LinkedIn     ${links.linkedin}`);
  out.push(`  Bluesky      ${links.bluesky}`);
  out.push(`  Reddit       ${links.reddit}`);
  out.push("");
  out.push("Copy text (for Slack / Discord / a PR):");
  out.push(text.split("\n").map((l) => `  ${l}`).join("\n"));
  if (!showRules && d.broken > 0) {
    out.push("");
    out.push("(Rule names are left out. Add them with --show-rules if you want them in the copy-text.)");
  }
  return out.join("\n");
}
