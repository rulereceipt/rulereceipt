import { describe, it, expect } from "vitest";
import { generateReport } from "../src/report/generateReport.js";
import type { CheckResult } from "../src/types.js";

/**
 * Five outcomes, not three, and each one says how it was reached.
 *
 * From anthropics/claude-code#90542. The failure that started this was not a
 * bad matcher, it was vocabulary reuse: with no API key the tool printed
 * "13 couldn't tell" — a phrase this codebase defines as "the tool looked
 * and the evidence was ambiguous" — about thirteen rules it had never
 * examined. As stonianua put it: that is `method=not_run` rendered as
 * inconclusive, and once `not_run` is its own result the lie has nowhere to
 * sit, however good or bad the matcher is.
 *
 *   pass / fail        a verdict, reached by a named method
 *   inconclusive       it looked, the evidence did not settle it
 *   not_run            no check happened — no key, an error, no ratified reading
 *   not_applicable     the trigger never fired, so there was nothing to judge
 *
 * `not_applicable` matters as much as `not_run`. A session that never
 * touched git cannot have violated a git rule, and reporting that as
 * "followed" inflates a report with 2,770 green ticks for work nobody did —
 * measured on an empty transcript across the 559-file corpus.
 *
 * `ceiling` is the other half: a text scan may say "no occurrence of these
 * spellings in this scope". It may not say "the act did not happen".
 */
function r(over: Partial<CheckResult>): CheckResult {
  return {
    ruleId: "1",
    ruleTitle: "Never force push",
    ruleSource: "project",
    status: "UNCLEAR",
    evidence: "e",
    ...over,
  };
}
const meta = { sessionFilePath: null, ruleCount: 1 };

describe("the report distinguishes a check that did not run", () => {
  it("does not call an unrun check 'couldn't tell'", () => {
    const out = generateReport([r({ outcome: "not_run", method: "none", evidence: "no ANTHROPIC_API_KEY set" })], meta);
    expect(out).not.toMatch(/couldn't tell/i);
    expect(out).toMatch(/not run|didn't run|did not run/i);
  });

  it("counts unrun checks separately in the summary", () => {
    const out = generateReport(
      [
        r({ outcome: "pass", method: "file_events", evidence: "never written to" }),
        r({ ruleId: "2", outcome: "not_run", method: "none", evidence: "no key" }),
        r({ ruleId: "3", outcome: "not_run", method: "none", evidence: "no key" }),
      ],
      { sessionFilePath: null, ruleCount: 3 }
    );
    expect(out).toMatch(/2 (?:were )?not (?:run|checked)/i);
  });

  it("separates 'the trigger never fired' from 'followed'", () => {
    // A session that never touched git did not "follow" a git rule.
    const out = generateReport(
      [r({ outcome: "not_applicable", method: "git_events", evidence: "no git command ran this session" })],
      meta
    );
    expect(out).not.toMatch(/^Followed/m);
    expect(out).toMatch(/not applicable|didn't apply|did not apply/i);
  });

  it("prints the ceiling next to a pass, so it cannot overclaim", () => {
    const out = generateReport(
      [
        r({
          outcome: "pass",
          method: "text_scan",
          ceiling: "no occurrence of these spellings in the recorded commands — not proof the act did not happen",
          evidence: "no occurrence of \"git push --force\"",
        }),
      ],
      meta
    );
    expect(out).toMatch(/not proof/i);
  });

  it("still renders results that carry no outcome field", () => {
    // Every checker has to keep working while they are migrated one at a time.
    const out = generateReport([r({ status: "PASS", evidence: "legacy shape" })], meta);
    expect(out).toMatch(/legacy shape/);
  });
});
