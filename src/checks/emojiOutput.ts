import type { EmojiClassification } from "./classify.js";
import type { CheckResult, TranscriptEvent } from "../types.js";
import { violation } from "../types.js";

/**
 * Emoji, as distinct from "any character a keyboard cannot type".
 *
 * Deliberately narrow. Accented Latin, CJK, mathematical symbols, arrows,
 * dashes, degree signs and the check mark are NOT emoji, and a rule banning
 * emoji must not fire on "café", "日本語", "±3°C" or "2×3". Those are
 * ordinary text to the people who write them, and treating them as a
 * violation would make this checker useless outside English.
 *
 * Covered: the pictographic blocks, the emoticon block, transport and map
 * symbols, supplemental symbols, flags, and the dingbats that are actually
 * rendered as emoji. Variation-selector-16 is included because it is what
 * turns an otherwise plain glyph into its emoji presentation.
 */
const EMOJI =
  /[\u{1F300}-\u{1F5FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{2600}-\u{26FF}\u{FE0F}]/u;

/** Every distinct emoji in a string, in order of first appearance. */
function emojiIn(text: string): string[] {
  const found: string[] = [];
  for (const ch of text) {
    if (EMOJI.test(ch) && ch !== "️" && !found.includes(ch)) found.push(ch);
  }
  return found;
}

/**
 * Did the assistant emit an emoji, against a rule forbidding it?
 *
 * One of the very few OUTPUT rules that can be answered mechanically. Most
 * of what a rules file forbids leaves no event to inspect; this one lands in
 * assistant text, which both the transcript and the Stop hook can read.
 *
 * Raised by anthropics/claude-code#94219: instructions said "avoid emojis
 * unless the user explicitly asks", the model sent one, then appended a
 * parenthetical retracting it rather than removing it. The retraction is why
 * this reads the text rather than trusting the session's own account of
 * itself — the apology and the emoji were in the same message.
 *
 * Only ASSISTANT text counts. A user who sends an emoji has not broken the
 * assistant's rule, and an earlier version of this check that scanned every
 * event would have reported one.
 */
export function runEmojiChecks(
  classifications: EmojiClassification[],
  events: TranscriptEvent[]
): CheckResult[] {
  let first: { emoji: string[]; text: string } | null = null;
  for (const event of events) {
    if (event.kind !== "text" || event.role !== "assistant") continue;
    const found = emojiIn(event.text);
    if (found.length === 0) continue;
    first = { emoji: found, text: event.text };
    break;
  }

  return classifications.map(({ rule, polarity }) => {
    if (first) {
      const at = first.text.indexOf(first.emoji[0]);
      const excerpt = first.text.slice(Math.max(0, at - 40), at + 40).replace(/\s+/g, " ").trim();
      return violation(
        rule,
        polarity,
        `the assistant's reply contained ${first.emoji.slice(0, 4).join(" ")} — "…${excerpt}…"`,
        { method: "emoji_output" }
      );
    }
    return {
      ruleId: rule.id,
      ruleTitle: rule.title,
      ruleSource: rule.source,
      status: "PASS" as const,
      outcome: "pass" as const,
      evidence: "no emoji appears in anything the assistant said this session",
      ceiling: "a scan of the assistant's recorded text — it cannot see anything said outside this transcript",
    };
  });
}
