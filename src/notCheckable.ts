/**
 * "Not checkable from a session" — the honest third kind of unresolved rule.
 *
 * The deterministic pass already splits unresolved rules into "couldn't tell"
 * (a mechanical check ran, the evidence was ambiguous) and "needs judgment" (a
 * human call the session could still inform — e.g. "surface bad news first", you
 * can read whether the session did). This adds a stricter sub-class of the
 * second: rules about INTERNAL disposition — intent, mindset, care, style —
 * that NO transcript can confirm or refute, because they are about how someone
 * was thinking, not anything they did. "Think carefully", "use good judgment",
 * "be thorough", "don't overthink it". Handing one of these to the judge is
 * asking it to grade a state of mind from a log; the honest answer is that it is
 * not a session question at all.
 *
 * Keeping these separate stops the judge from manufacturing a verdict on them
 * and stops the report from reading as if a huge number of rules "failed a
 * check" when they were never a check to begin with. A verdict's STATUS is
 * unchanged (still UNCLEAR) — this only refines how it is displayed and counted.
 *
 * The classifier is deliberately conservative: it fires only on a clear
 * intent/mindset signal, so a borderline rule stays "needs judgment" (where the
 * judge may still help) rather than being written off as uncheckable.
 */

// Phrases that mark a rule as being about internal disposition rather than an
// observable action. Matched case-insensitively as whole words/phrases.
const INTENT_SIGNALS: RegExp[] = [
  /\bthink (carefully|hard|step[- ]by[- ]step|things through|it through|before)\b/i,
  /\bthink\b.*\bbefore (you|acting|coding|answering|responding)\b/i,
  /\b(be|stay|remain) (careful|thoughtful|mindful|thorough|diligent|deliberate|patient|rigorous|meticulous)\b/i,
  /\b(carefully|thoughtfully|mindfully|thoroughly|deliberately) (consider|review|read|weigh|reason)\b/i,
  /\buse (your |good |common |sound )?(judg(e)?ment|sense|intuition|discretion)\b/i,
  /\b(keep|bear)\b[^.]{0,40}\bin mind\b/i,
  /\bpay (close )?attention\b/i,
  /\battention to detail\b/i,
  /\b(mindset|mind[- ]set|frame of mind|state of mind)\b/i,
  /\b(the )?spirit of\b/i,
  /\b(don'?t|do not|never) overthink\b/i,
  /\b(take|with) care\b/i,
  /\bbe (reasonable|sensible|pragmatic)\b/i,
  /\bapproach (this|the problem|tasks?) (with|thoughtfully|carefully)\b/i,
];

/**
 * True when a rule is about internal intent/mindset/care and so cannot be
 * confirmed or refuted from a transcript. Classifies from the rule's title and,
 * when given, its body text (titles are often the whole rule for these).
 */
export function isNotCheckableFromSession(ruleTitle: string, ruleText = ""): boolean {
  const hay = `${ruleTitle}\n${ruleText}`;
  return INTENT_SIGNALS.some((re) => re.test(hay));
}
