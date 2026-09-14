import { describe, it, expect } from "vitest";
import { classifyRule } from "../src/checks/classify.js";

/**
 * Claim-evidence must route on a CLAIM SHAPE — a reporting verb next to a
 * done-word — not on three words that each appear somewhere in the same
 * section.
 *
 * The three-independent-words test has mis-routed repeatedly, and each time
 * it was patched with another blocklist entry (PRE_ACTION_GATE) rather than
 * fixed. Found again 2026-09-14 on a real run: a rule titled "Milestone
 * updates - write one for Slack, every time" was answered with a verdict
 * about whether a test command was piped. Its done-word came from the
 * phrase "Slack-ready post"; its reporting verb and evidence noun came from
 * two other paragraphs.
 *
 * Every body below is VERBATIM from a public CLAUDE.md in the measurement
 * corpus, at full length. Shortened versions of these were tried first and
 * silently stopped reproducing the bug - the scatter needs the length. That
 * mistake has now been made four times on this checker, so: full text, real
 * files, no paraphrase.
 *
 * The three that keep routing all say the same thing in different words:
 * do not announce completion you have not verified. The two that stop are a
 * list of coding principles and a rule about tagging accuracy numbers -
 * neither is answerable by comparing a claim to a tool result, and a
 * confident irrelevant verdict costs more than declining to route.
 */
const kindOf = (title: string, text: string) =>
  classifyRule({ id: "1", title, text, source: "project" }).kind;

describe("claim-evidence routes on the claim shape, not scattered words", () => {
  it("routes: Output Expectations", () => {
    expect(kindOf("Output Expectations", "For generated patches or edits:\r\n\r\n- Use repository-relative paths.\r\n- Include every required supporting file.\r\n- Avoid unrelated formatting changes.\r\n- Do not claim tests passed unless they were run.\r\n- State database, configuration, cache, upgrade, and uninstall impact.")).toBe("claimEvidence");
  });

  it("routes: Completion Checklist", () => {
    expect(kindOf("Completion Checklist", "Before declaring work complete, verify:\r\n\r\n- The module follows proven repository patterns.\r\n- The module can load correctly in the target runtime.\r\n- Every API method has appropriate authorization.\r\n- Portal, module, user, and record scope are validated server-side.\r\n- Settings use the correct scope.\r\n- Relevant caches are cleared after writes.\r\n- User-facing strings are localized where required.\r\n- Mobile behavior is intentional.\r\n- Icon-only actions are accessible.\r\n- Destructive actions require clear confirmation.\r\n- SQL is repeatable where requested.\r\n- Upgrade logic is safe and idempotent.\r\n- Uninstall removes all module-owned objects.\r\n- The manifest and package include every required file.\r\n- Existing data and users are protected.\r\n- Errors are logged without exposing secrets.\r\n- Delivery is complete and contains no unrelated changes.")).toBe("claimEvidence");
  });

  it("routes: Feature Validation", () => {
    expect(kindOf("Feature Validation", "After implementing a feature request, before wrapping up, confirm how it should be validated \u2014 don't assume:\n\n1. **Simple** \u2014 just verify the build passes (`npm run build`). Good for changes that don't meaningfully alter runtime behavior (e.g. simple refactors, typing fixes, CSS tweaks, translation updates).\n2. **Complex** \u2014 simulate the user flow with Playwright against the emulators (sign in, navigate to the feature, exercise it end-to-end). Good for anything that changes user-facing behavior, data flow, or backend logic. **Requires explicit approval** \u2014 do not open a browser or run Playwright unless the user approves this validation level for the task.\n\n**Be adaptive:**\n- If the change is truly trivial (e.g. a one-line comment, a copy change, or a small non-behavioral tweak), skip the question and note that no validation is needed.\n- Otherwise, ask the user which validation level applies before declaring the feature done.")).toBe("claimEvidence");
  });

  it("does not route: KARPATHY BEHAVIORAL GUIDELINES", () => {
    expect(kindOf("KARPATHY BEHAVIORAL GUIDELINES", "Follow `.agent/rules/10_karpathy_guidelines.md` for all coding tasks:\r\n1. **Think Before Coding** \u2014 State assumptions explicitly. Ask if uncertain. Surface tradeoffs.\r\n2. **Simplicity First** \u2014 Minimum code that solves the problem. Nothing speculative.\r\n3. **Surgical Changes** \u2014 Touch only what you must. Don't improve unrelated code.\r\n4. **Goal-Driven Execution** \u2014 Define success criteria. Loop until verified.")).not.toBe("claimEvidence");
  });

  it("does not route: The one rule: prove everything", () => {
    expect(kindOf("The one rule: prove everything", "This project was accused of AI-slop; the fix is hard discipline. Before you quote ANY\naccuracy number:\n\n1. It must be tagged **MEASURED** (with a reproducer named), **CLAIMED**, or **SYNTHETIC**.\n2. Pose PCK is quoted only as a **delta over the mean-pose baseline** on a leakage-free\n   held-out split; that baseline can otherwise make an unusable model look strong.\n3. Run `ruview_claim_check` on any report/PR/model-card. It flags untagged numbers and\n   the project's retracted perfect-accuracy framing.\n4. Firmware is \"hardware-validated\" only with a captured **boot log on real silicon** \u2014\n   never on a build-passes signal.")).not.toBe("claimEvidence");
  });
});
