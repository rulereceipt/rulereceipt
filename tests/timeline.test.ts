import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { buildTimeline, renderTimelineHtml, type TimelineMeta } from "../src/timeline.js";
import type { CheckResult } from "../src/types.js";

function r(over: Partial<CheckResult>): CheckResult {
  return { ruleId: "1", ruleTitle: "rule", ruleSource: "project", status: "PASS", evidence: "", ...over };
}

const meta: TimelineMeta = {
  projectPath: "/Users/someone/proj",
  sessionName: "session.jsonl",
  sessionFingerprint: "abc123",
  generatedAt: new Date("2026-10-16T09:00:00.000Z"),
  toolVersion: "0.1.110",
};

describe("buildTimeline — order existing verdicts by where they occur in the session", () => {
  it("places verdicts in transcript order, earliest first", () => {
    const transcript = [
      `{"type":"user","message":{"role":"user","content":"start"}}`,
      `a line with "first break here" in it`,
      `some middle line`,
      `nothing of interest`,
      `a line with "second break here" in it`,
    ].join("\n");
    const t = buildTimeline(
      [
        r({ ruleId: "B", ruleTitle: "second rule", status: "FAIL", evidence: `pushed — "second break here"` }),
        r({ ruleId: "A", ruleTitle: "first rule", status: "FAIL", evidence: `edited — "first break here"` }),
      ],
      transcript
    );
    // Given out of order; the timeline sorts by where the evidence sits.
    expect(t.placed.map((v) => v.ruleId)).toEqual(["A", "B"]);
    expect(t.placed[0].line).toBeLessThan(t.placed[1].line);
    expect(t.counts.broken).toBe(2);
  });

  it("puts a not-visible FAIL in the not-visible lane, not broken (reuses visibility)", () => {
    // A system-reminder (context machinery) is present but no rules file was
    // injected before the break -> applyVisibility downgrades to not-in-context.
    const transcript = [
      `<system-reminder>some context</system-reminder>`,
      `the agent ran "edited the env file" without the rule loaded`,
    ].join("\n");
    const t = buildTimeline(
      [r({ ruleId: "E", ruleTitle: "Never edit .env", status: "FAIL", evidence: `wrote — "edited the env file"` })],
      transcript
    );
    expect(t.counts.broken).toBe(0);
    expect(t.counts.notVisible).toBe(1);
    const entry = t.placed[0] ?? t.unplaced[0];
    expect(entry.lane).toBe("not-visible");
  });

  it("leaves a judgment call with no locatable evidence unplaced", () => {
    const t = buildTimeline(
      [r({ ruleId: "J", ruleTitle: "Surface bad news first", status: "UNCLEAR", needsHuman: true, evidence: "needs a human to decide" })],
      "a transcript\nwith no matching fragment at all"
    );
    expect(t.placed).toHaveLength(0);
    expect(t.unplaced.map((v) => v.lane)).toEqual(["needs-judgment"]);
    expect(t.counts.needsJudgment).toBe(1);
  });

  it("marks a compaction on the timeline, between the verdicts around it", () => {
    const transcript = [
      `a line with "early break" here`,
      `{"isCompactSummary":true}`,
      `a line with "late break" here`,
    ].join("\n");
    const t = buildTimeline(
      [
        r({ ruleId: "A", ruleTitle: "a", status: "FAIL", evidence: `"early break"` }),
        r({ ruleId: "B", ruleTitle: "b", status: "FAIL", evidence: `"late break"` }),
      ],
      transcript
    );
    expect(t.markers).toHaveLength(1);
    expect(t.markers[0].kind).toBe("compaction");
    expect(t.placed[0].line).toBeLessThan(t.markers[0].line);
    expect(t.markers[0].line).toBeLessThan(t.placed[1].line);
  });

  it("counts every lane", () => {
    const t = buildTimeline(
      [
        r({ ruleId: "1", status: "PASS", evidence: "did it" }),
        r({ ruleId: "2", status: "FAIL", evidence: "broke it" }),
        r({ ruleId: "3", status: "UNCLEAR", needsHuman: true, evidence: "" }),
        r({ ruleId: "4", status: "UNCLEAR", evidence: "" }),
      ],
      "nothing here matches"
    );
    expect(t.counts).toMatchObject({ broken: 1, followed: 1, needsJudgment: 1, cantTell: 1, notVisible: 0 });
  });
});

describe("renderTimelineHtml — self-contained, safe HTML", () => {
  it("escapes HTML in rule titles and evidence (no stored XSS)", () => {
    const t = buildTimeline(
      [r({ ruleTitle: `<img src=x onerror=alert(1)>`, status: "FAIL", evidence: `"<script>alert(2)</scr` + `ipt>"` })],
      `a line with "<script>alert(2)</scr` + `ipt>" in it`
    );
    const html = renderTimelineHtml(t, meta);
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("alert(2)</scr" + "ipt>");
    expect(html).toContain("&lt;img");
  });

  it("is a single self-contained file — no external requests, no inline script", () => {
    const t = buildTimeline([r({ status: "PASS", evidence: "" })], "x");
    const html = renderTimelineHtml(t, meta);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/https?:\/\//i);
    expect(html).toContain("<!doctype html>");
  });

  it("redacts the user's home directory in evidence", () => {
    const home = homedir();
    // Only meaningful when there is a real home to redact.
    if (!home || home.length < 4) return;
    const t = buildTimeline(
      [r({ ruleTitle: "x", status: "FAIL", evidence: `read — "touched ${home}/secret.txt"` })],
      `a line "touched ${home}/secret.txt"`
    );
    const html = renderTimelineHtml(t, { ...meta, projectPath: `${home}/proj` });
    expect(html).not.toContain(`${home}/secret.txt`);
    expect(html).toContain("~/secret.txt");
  });

  it("renders without crashing on an empty timeline", () => {
    const t = buildTimeline([], "");
    const html = renderTimelineHtml(t, meta);
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("RuleReceipt");
  });
});
