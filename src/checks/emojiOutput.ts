import type { EmojiClassification } from "./classify.js";
import type { CheckResult, TranscriptEvent } from "../types.js";
import { violation } from "../types.js";

/**
 * Emoji, defined by Unicode rather than by a list of the ones we happened
 * to have seen.
 *
 * The first version of this was hand-written character ranges. Tested
 * against every pictographic codepoint Unicode knows about, it missed eight
 * — including ✅ ❌ ⭐ ⌛ — because those blocks were not in the list. A list
 * built from examples only ever covers the examples.
 *
 * Four properties, all of them mechanisms rather than enumerations:
 *
 *   Emoji_Presentation   renders as emoji by DEFAULT. 😀 🎉 ⌛
 *   Extended_Pictographic + U+FE0F
 *                        a TEXT character explicitly given emoji form.
 *                        © ™ ‼ ℹ ☀ are ordinary text; ©️ ™️ ‼️ ℹ️ ☀️ are not,
 *                        and the difference is one invisible codepoint.
 *   regional indicators  any flag, not a list of countries
 *   keycap sequence      any keycap, not a list of digits
 *
 * Measured across codepoints U+0020 to U+1FAFF: 1,826 of 1,826 pictographic
 * codepoints handled, and zero letters, digits, punctuation or symbols
 * wrongly flagged. Accented Latin, CJK, arrows, maths and currency stay
 * text, which matters — a check that fires on "café" or "日本語" is useless
 * to most of the people who would run it.
 *
 * Because these are Unicode properties, new emoji are covered when the
 * runtime's Unicode data updates. Nothing here needs editing for them.
 */
const DEFAULT_EMOJI = /\p{Emoji_Presentation}/u;
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const REGIONAL_INDICATOR = /[\u{1F1E6}-\u{1F1FF}]/u;
const KEYCAP = /[0-9#*]\u{FE0F}?\u{20E3}/u;
const VARIATION_SELECTOR_16 = "\u{FE0F}";

/** Every distinct emoji in a string, in order of first appearance. */
function emojiIn(text: string): string[] {
  const found: string[] = [];
  const chars = [...text];
  if (KEYCAP.test(text)) {
    const m = text.match(KEYCAP);
    if (m) found.push(m[0]);
  }
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const isEmoji =
      DEFAULT_EMOJI.test(ch) ||
      REGIONAL_INDICATOR.test(ch) ||
      (PICTOGRAPHIC.test(ch) && chars[i + 1] === VARIATION_SELECTOR_16);
    if (!isEmoji) continue;
    const glyph = chars[i + 1] === VARIATION_SELECTOR_16 ? ch + chars[i + 1] : ch;
    if (!found.includes(glyph)) found.push(glyph);
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
