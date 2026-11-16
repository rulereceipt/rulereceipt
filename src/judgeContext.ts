/**
 * Judge context — a bounded, keyword-matched excerpt of the session for a rule
 * the deterministic pass could not resolve.
 *
 * The judge (a fresh subagent in the plugin) is handed the rule, this excerpt,
 * and the transcript PATH so it can read or grep further on its own. The excerpt
 * is only a starting point: it points the subagent at the turns most likely to
 * bear on the rule, so it is not judging from a placeholder or searching a huge
 * log blind. Everything here is bounded — a giant session can never produce a
 * giant excerpt — and nothing here is a verdict or affects a count.
 */

// Words too common to be a useful search key. Kept small and generic.
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "else", "for", "to", "of", "in", "on", "at", "by",
  "is", "are", "was", "were", "be", "been", "being", "it", "its", "this", "that", "these", "those",
  "with", "without", "not", "no", "never", "always", "must", "should", "shall", "will", "would", "can",
  "cannot", "do", "does", "did", "done", "you", "your", "they", "them", "their", "any", "each", "every",
  "before", "after", "when", "while", "than", "from", "into", "out", "up", "down", "over", "under",
  "rule", "rules", "use", "used", "using", "make", "made", "new", "only", "all", "one", "first", "last",
]);

/** Distinctive search keys from a rule's title/text: identifiers, quoted
 * strings, code-ish tokens, and salient words. Lower-cased, de-duped, bounded. */
export function ruleKeywords(ruleTitle: string, ruleText = ""): string[] {
  const src = `${ruleTitle}\n${ruleText}`;
  const keys = new Set<string>();
  // 1) Quoted strings and inline-code spans — usually the exact thing to find.
  for (const m of src.matchAll(/[`"']([^`"']{2,60})[`"']/g)) keys.add(m[1].trim().toLowerCase());
  // 2) Code-ish tokens: dotfiles, paths, flags, commands (.env, --llm, git push, foo/bar).
  for (const m of src.matchAll(/(?:^|\s)((?:--|\.|\/)?[A-Za-z0-9][\w./-]{2,40})/g)) {
    const t = m[1].toLowerCase();
    if (/[./-]/.test(t) || t.startsWith("--")) keys.add(t);
  }
  // 3) Salient plain words (length > 3, not a stopword).
  for (const m of src.toLowerCase().matchAll(/[a-z][a-z0-9]{3,}/g)) {
    if (!STOPWORDS.has(m[0])) keys.add(m[0]);
  }
  // Longest/most-distinctive first, capped — long keys match more precisely.
  return [...keys].sort((a, b) => b.length - a.length).slice(0, 12);
}

// Keys in a Claude Code / Codex JSONL line that hold things a RULE is about —
// what was said and what was run. Everything else (ids, timestamps, snapshots,
// file backups) is scaffolding the judge should not be reading.
const CONTENT_KEYS = new Set([
  "text", "content", "command", "description", "input", "stdout", "stderr",
  "old_string", "new_string", "prompt", "name", "file_path", "pattern",
]);

/**
 * The human-readable projection of one transcript line: if it is JSON, the
 * string values under content-bearing keys (recursively), joined; otherwise the
 * line itself. This keeps keyword matching and the excerpt on what was said and
 * done, not on JSON structure. Bounded, and never throws.
 */
export function readableLine(line: string): string {
  const t = line.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return line;
  let parsed: unknown;
  try {
    parsed = JSON.parse(t);
  } catch {
    return line;
  }
  const out: string[] = [];
  const visit = (node: unknown, underContentKey: boolean, depth: number): void => {
    if (depth > 8 || out.length > 40) return;
    if (typeof node === "string") {
      if (underContentKey && node.length > 1 && !/^[0-9a-f-]{16,}$/i.test(node)) out.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const v of node) visit(v, underContentKey, depth + 1);
      return;
    }
    if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) visit(v, underContentKey || CONTENT_KEYS.has(k), depth + 1);
    }
  };
  visit(parsed, false, 0);
  return out.length > 0 ? out.join(" ").replace(/\s+/g, " ") : "";
}

export interface JudgeContext {
  /** The transcript file to read/grep for more, or null for demo data. */
  transcriptPath: string | null;
  /** A bounded excerpt of the lines that mention the rule's keywords. */
  excerpt: string;
  /** How many transcript lines matched a keyword (before the cap). */
  matchCount: number;
}

interface ExcerptOpts {
  maxChars?: number;
  maxLines?: number;
  context?: number; // lines of context on each side of a match
  scanLineCap?: number; // never scan more than this many lines (huge-session guard)
}

/**
 * A bounded excerpt of `transcriptText` around the lines that mention any of the
 * rule's keywords. Deterministic, size-capped, and safe on a very large session
 * (it stops scanning after `scanLineCap` lines). Returns the excerpt plus the
 * raw match count so the caller knows how much was there.
 */
export function extractExcerpt(
  ruleTitle: string,
  transcriptText: string,
  transcriptPath: string | null,
  ruleText = "",
  opts: ExcerptOpts = {}
): JudgeContext {
  const maxChars = opts.maxChars ?? 1800;
  const maxLines = opts.maxLines ?? 24;
  const context = opts.context ?? 1;
  const scanLineCap = opts.scanLineCap ?? 60000;

  const keys = ruleKeywords(ruleTitle, ruleText);
  if (keys.length === 0 || transcriptText.length === 0) {
    return { transcriptPath, excerpt: "", matchCount: 0 };
  }
  const rawLines = transcriptText.split("\n");
  const scanN = Math.min(rawLines.length, scanLineCap);
  // Project each line to its readable content ONCE, so matching and the excerpt
  // both see what was said/done, not JSON scaffolding.
  const readable: string[] = new Array(scanN);
  const wanted = new Set<number>();
  let matchCount = 0;
  for (let i = 0; i < scanN; i++) {
    const text = readableLine(rawLines[i]);
    readable[i] = text;
    if (text.length === 0) continue;
    const low = text.toLowerCase();
    if (keys.some((k) => low.includes(k))) {
      matchCount++;
      for (let j = Math.max(0, i - context); j <= Math.min(scanN - 1, i + context); j++) wanted.add(j);
    }
  }
  // Assemble in order, with gap markers, within the line and char caps. Blank
  // (scaffolding-only) lines are skipped so the excerpt is dense with content.
  const idxs = [...wanted].sort((a, b) => a - b);
  const parts: string[] = [];
  let prev = -2;
  let chars = 0;
  for (const i of idxs) {
    const text = readable[i];
    if (!text) continue;
    if (parts.length >= maxLines) break;
    if (i !== prev + 1 && parts.length > 0) parts.push("…");
    const line = text.length > 300 ? text.slice(0, 300) + "…" : text;
    if (chars + line.length > maxChars) break;
    parts.push(line);
    chars += line.length + 1;
    prev = i;
  }
  return { transcriptPath, excerpt: parts.join("\n"), matchCount };
}
