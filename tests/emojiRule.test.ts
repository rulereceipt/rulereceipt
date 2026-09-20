import { describe, it, expect } from "vitest";
import { classifyRule } from "../src/checks/classify.js";
import { runEmojiChecks } from "../src/checks/emojiOutput.js";
import type { EmojiClassification } from "../src/checks/classify.js";
import type { TranscriptEvent } from "../src/types.js";

/**
 * "No emoji" is checkable, and was being counted as a judgment call.
 *
 * From anthropics/claude-code#94219, 2026-09-14: project instructions said
 * "avoid emojis unless the user explicitly asks", the model sent one anyway,
 * then appended a parenthetical retracting it instead of removing it.
 *
 * Every phrasing of that rule routed to judgment here, including one naming
 * an emoji in backticks — the literal is rejected as unusable because it
 * carries no alphanumerics. So the rule counted toward the 64.8% of rules
 * said to need a human, when a human is not needed: an emoji in the output
 * either is there or is not, and the check is a codepoint range.
 *
 * It is also one of the few OUTPUT rules a gate can hold. Most of what a
 * rules file forbids has no event; this one lands in assistant text, which
 * Stop receives.
 *
 * Scope kept deliberately narrow: the rule must be about emoji, and it must
 * forbid them. "Use these emoji consistently across all chat output" is a
 * real corpus rule and must never be read as a prohibition.
 */
const rule = (text: string, title = "Formatting") => ({ id: "1", title, text, source: "project" as const });
const says = (text: string): TranscriptEvent => ({ role: "assistant", kind: "text", text, timestamp: "t" });
const cls = (text: string) => [{ kind: "emojiOutput", rule: rule(text), polarity: "forbid" }] as unknown as EmojiClassification[];

describe("emoji rules are checked, not deferred to a human", () => {
  for (const t of [
    "Avoid emojis unless the user explicitly asks.",
    "Never use emojis in replies.",
    "Do not use emoji in commit messages or chat.",
  ]) {
    it(`routes: ${t.slice(0, 40)}`, () => expect(classifyRule(rule(t)).kind).toBe("emojiOutput"));
  }

  it("does not route a rule that PRESCRIBES emoji", () => {
    expect(classifyRule(rule("Use these emoji consistently across all chat output so users can scan.")).kind)
      .not.toBe("emojiOutput");
  });

  it("does not route a rule that merely mentions emoji in passing", () => {
    expect(classifyRule(rule("The agent's identity file holds its name, vibe and emoji.")).kind)
      .not.toBe("emojiOutput");
  });

  it("fails when the assistant actually emitted one", () => {
    const [r] = runEmojiChecks(cls("Never use emojis in replies."), [says("Done 🎉 — shipped.")]);
    expect(r.status).toBe("FAIL");
    expect(r.evidence).toContain("🎉");
  });

  it("catches the retraction case from the report", () => {
    const [r] = runEmojiChecks(cls("Avoid emojis unless the user explicitly asks."), [
      says("Nice work 👍 (didn't mean to use that emoji – retracting it)"),
    ]);
    expect(r.status).toBe("FAIL");
  });

  it("passes when the session used none", () => {
    const [r] = runEmojiChecks(cls("Never use emojis in replies."), [says("Done. Shipped, tests green.")]);
    expect(r.status).not.toBe("FAIL");
  });

  it("ignores emoji the USER sent", () => {
    const [r] = runEmojiChecks(cls("Never use emojis in replies."), [
      { role: "user", kind: "text", text: "thanks 🎉", timestamp: "t" },
    ]);
    expect(r.status).not.toBe("FAIL");
  });

  it("does not fire on ordinary punctuation, accents or CJK", () => {
    const [r] = runEmojiChecks(cls("Never use emojis in replies."), [
      says("café — naïve, 日本語, ±3°C, ✓ done, 2×3"),
    ]);
    expect(r.status).not.toBe("FAIL");
  });
});

/**
 * Coverage is a Unicode property, not a list of the emoji we have seen.
 *
 * The first detector was hand-written ranges and missed eight pictographic
 * codepoints including ✅ ❌ ⭐ ⌛, because those blocks were not in the list.
 * This walks every codepoint Unicode calls pictographic and asserts the
 * detector agrees with Unicode rather than with its author's examples.
 */
describe("emoji detection is defined by Unicode, not by examples", () => {
  const rule = { id: "1", title: "Formatting", text: "Never use emojis in replies.", source: "project" as const };
  const cls = [{ kind: "emojiOutput", rule, polarity: "forbid" }] as unknown as EmojiClassification[];
  const fires = (s: string) =>
    runEmojiChecks(cls, [{ role: "assistant", kind: "text", text: s, timestamp: "t" }])[0].status === "FAIL";

  it("catches every pictographic codepoint Unicode knows about", () => {
    const PICTO = /\p{Extended_Pictographic}/u;
    const DEFAULT_EMOJI = /\p{Emoji_Presentation}/u;
    const missed: string[] = [];
    let total = 0;
    for (let cp = 0x20; cp <= 0x1faff; cp++) {
      const ch = String.fromCodePoint(cp);
      if (!PICTO.test(ch)) continue;
      total += 1;
      // A default-text pictograph is only an emoji with VS16 after it.
      const probe = DEFAULT_EMOJI.test(ch) ? ch : ch + "\u{FE0F}";
      if (!fires(`done ${probe} ok`)) missed.push(`U+${cp.toString(16)}`);
    }
    expect(total).toBeGreaterThan(1500);
    expect(missed).toEqual([]);
  });

  it("never fires on letters, digits, punctuation or symbols", () => {
    const DEFAULT_EMOJI = /\p{Emoji_Presentation}/u;
    const wrong: string[] = [];
    for (let cp = 0x20; cp <= 0x2fff; cp++) {
      const ch = String.fromCodePoint(cp);
      if (!/\p{L}|\p{N}|\p{P}|\p{Zs}|\p{S}/u.test(ch)) continue;
      if (DEFAULT_EMOJI.test(ch)) continue; // genuinely an emoji, e.g. ⌛
      if (fires(`x ${ch} y`)) wrong.push(`${ch} U+${cp.toString(16)}`);
    }
    expect(wrong).toEqual([]);
  });

  it("treats the same character as text or emoji depending on VS16", () => {
    expect(fires("copyright © 2026")).toBe(false);
    expect(fires("copyright ©\u{FE0F} 2026")).toBe(true);
  });

  it("handles any flag and any keycap, not a list of them", () => {
    for (const f of ["🇮🇳", "🇯🇵", "🇧🇷", "🇿🇦"]) expect(fires(`from ${f}`)).toBe(true);
    for (const k of ["1\u{FE0F}\u{20E3}", "7\u{FE0F}\u{20E3}", "#\u{FE0F}\u{20E3}"]) expect(fires(`step ${k}`)).toBe(true);
  });
});
