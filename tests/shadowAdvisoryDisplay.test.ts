import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generateHtmlReport, type HtmlReportMeta } from "../src/report/generateHtmlReport.js";
import { buildTimeline, renderTimelineHtml, type TimelineMeta } from "../src/timeline.js";
import { detectShadowSignals } from "../src/checks/shadowSignals.js";
import type { CheckResult, Rule, TranscriptEvent } from "../src/types.js";
import type { ShadowFinding } from "../src/checks/shadowSignals.js";

/**
 * Shadow signals are advisory facts, never verdicts. These tests hold the
 * display contract for surfacing them in the two HTML outputs:
 *   1. they appear, clearly labeled "not a verdict";
 *   2. they are escaped like all other untrusted input (stored-XSS surface);
 *   3. surfacing them changes NEITHER the verdict counts NOR the exit code.
 */

function result(over: Partial<CheckResult> = {}): CheckResult {
  return {
    ruleId: "1",
    ruleTitle: "Never commit directly to main",
    ruleSource: "project",
    status: "PASS",
    evidence: "no git command targeted the main branch",
    ...over,
  };
}

function htmlMeta(over: Partial<HtmlReportMeta> = {}): HtmlReportMeta {
  return {
    sessionFilePath: null,
    ruleCount: 1,
    projectPath: "/home/dev/acme-api",
    generatedAt: new Date("2026-10-17T09:00:00.000Z"),
    toolVersion: "0.1.111",
    ...over,
  };
}

const timelineMeta: TimelineMeta = {
  projectPath: "/Users/someone/proj",
  sessionName: "session.jsonl",
  sessionFingerprint: "abc123",
  generatedAt: new Date("2026-10-17T09:00:00.000Z"),
  toolVersion: "0.1.111",
};

const finding = (over: Partial<ShadowFinding> = {}): ShadowFinding => ({
  signal: "edited-rule-not-loaded",
  evidence: 'edited a file governed by "DB migrations" (CLAUDE.md), but no injection record for it — the agent may never have seen this rule',
  ...over,
});

// The count line the verdict box prints; it is derived ONLY from results, so it
// must be byte-identical whether or not an advisory is attached.
function countSpan(html: string): string {
  const m = html.match(/<span>(\d+ followed[^<]*)<\/span>/);
  if (!m) throw new Error("count span not found");
  return m[1];
}

describe("shadow advisory — HTML report", () => {
  it("renders the advisory, labeled as not-a-verdict, when findings are present", () => {
    const html = generateHtmlReport([result()], htmlMeta(), [finding()]);
    expect(html).toContain("Advisory — not a verdict");
    expect(html).toContain("edited-rule-not-loaded");
    expect(html).toContain("may never have seen this rule");
    // The label must disclaim verdict status in the same section.
    expect(html).toMatch(/not<\/strong>\s*verdicts/);
  });

  it("renders NO advisory section when there are no findings", () => {
    const html = generateHtmlReport([result()], htmlMeta(), []);
    expect(html).not.toContain("Advisory — not a verdict");
  });

  it("escapes a script payload inside a finding's evidence (stored-XSS surface)", () => {
    const html = generateHtmlReport(
      [result()],
      htmlMeta(),
      [finding({ evidence: "<script>alert(1)</script>" })]
    );
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("the advisory adds no inline script", () => {
    // (The report itself already carries a GitHub "report a wrong verdict" link
    // on PASS/FAIL rows — pre-existing and out of scope; the advisory must not
    // add script. The no-external-URL contract is asserted on the timeline.)
    const html = generateHtmlReport([result()], htmlMeta(), [finding()]);
    expect(html).not.toMatch(/<script/i);
    // The advisory block itself introduces no URL.
    const block = html.slice(html.indexOf("Advisory — not a verdict"));
    expect(block.split("How to read this report")[0]).not.toMatch(/https?:\/\//);
  });

  it("does NOT change the verdict counts when an advisory is attached", () => {
    const results = [
      result({ ruleId: "1", status: "PASS" }),
      result({ ruleId: "2", status: "FAIL", evidence: "committed to main" }),
      result({ ruleId: "3", status: "UNCLEAR", needsHuman: false, evidence: "ambiguous" }),
      result({ ruleId: "4", status: "UNCLEAR", needsHuman: true, evidence: "judgment" }),
    ];
    const without = generateHtmlReport(results, htmlMeta(), []);
    const withAdvisory = generateHtmlReport(results, htmlMeta(), [finding()]);
    expect(countSpan(withAdvisory)).toBe(countSpan(without));
    // And the headline verdict text is unchanged too.
    expect(withAdvisory).toContain("1 rule not followed");
    expect(countSpan(withAdvisory)).toBe("1 followed · 1 not followed · 1 couldn&#39;t tell · 1 need your judgment");
  });
});

describe("shadow advisory — timeline HTML", () => {
  const transcript = `{"type":"user"}\na line with "the break" in it`;

  it("renders the advisory under the same escape/no-script/no-URL contract", () => {
    const t = buildTimeline([result({ status: "PASS", evidence: "ok" })], transcript);
    const html = renderTimelineHtml(t, timelineMeta, [finding({ evidence: "<img src=x onerror=alert(1)>" })]);
    expect(html).toContain("Advisory — not a verdict");
    expect(html).toContain("edited-rule-not-loaded");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/https?:\/\//);
  });

  it("renders NO advisory section when there are no findings", () => {
    const t = buildTimeline([result()], transcript);
    const html = renderTimelineHtml(t, timelineMeta, []);
    expect(html).not.toContain("Advisory — not a verdict");
  });

  it("does NOT change the timeline lane counts when an advisory is attached", () => {
    const results = [
      result({ ruleId: "1", status: "FAIL", evidence: `pushed — "the break"` }),
      result({ ruleId: "2", status: "PASS", evidence: "ok" }),
    ];
    const t = buildTimeline(results, transcript);
    // buildTimeline does not even take findings — the counts are fixed by results.
    const htmlWithout = renderTimelineHtml(t, timelineMeta, []);
    const htmlWith = renderTimelineHtml(t, timelineMeta, [finding()]);
    const sub = (h: string) => h.match(/<p>([^<]*followed[^<]*)<\/p>/)?.[1];
    expect(sub(htmlWith)).toBe(sub(htmlWithout));
    expect(t.counts.broken).toBe(1);
    expect(t.counts.followed).toBe(1);
  });
});

describe("shadow advisory — the real detector's wording flows through, unsharpened", () => {
  // The edited-rule-not-loaded signal from the real detector must stay a
  // couldn't-tell ("may never have seen"), never a flat "not loaded".
  const scoped: Rule = {
    id: "r1",
    title: "DB migrations need review",
    text: "Always get a review before editing migrations.",
    source: "project",
    paths: ["src/db/**"],
    sourcePath: "/proj/src/db/CLAUDE.md",
    sourceLine: 1,
  };
  const edit: TranscriptEvent = { role: "assistant", kind: "tool_use", toolName: "Edit", input: { file_path: "/proj/src/db/schema.ts", content: "x" }, timestamp: "t" };
  const REMINDER = '{"type":"user","message":{"role":"user","content":"ok"}}\n<system-reminder>context</system-reminder>';

  it("surfaces the real finding in HTML with hedged wording", () => {
    const findings = detectShadowSignals([scoped], [edit], REMINDER);
    const hit = findings.find((f) => f.signal === "edited-rule-not-loaded");
    expect(hit).toBeDefined();
    // The detector's own evidence is a couldn't-tell ("may never have seen"),
    // never a flat "not loaded" claim — this is the regression guard.
    expect(hit!.evidence).toContain("may never have seen this rule");
    expect(hit!.evidence).not.toMatch(/\bnot loaded\b/i);
    const html = generateHtmlReport([result()], htmlMeta(), findings);
    expect(html).toContain("may never have seen this rule");
  });
});

describe("shadow advisory — end-to-end: does not change the exit code", () => {
  const CLI = resolve(__dirname, "..", "dist", "cli.js");
  let dir: string;

  // A session that FIRES edited-rule-not-loaded (edits a file governed by a
  // nested path-scoped rule, with context machinery present but no injection
  // record for that rule file) yet breaks NO checkable rule. The advisory must
  // show in the --html file while the process still exits 0.
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "rr-shadow-adv-"));
    mkdirSync(join(dir, "src", "db"), { recursive: true });
    // Root rule routes to judgment (needs a human) — never a FAIL.
    writeFileSync(join(dir, "CLAUDE.md"), "# Rules\n\n## 1. Review first\nAlways get a review before shipping.\n");
    // Nested path-scoped rule; also judgment, so no mechanical FAIL.
    writeFileSync(join(dir, "src", "db", "CLAUDE.md"), "# DB\n\n## 1. Migrations\nAlways get a review before editing migrations.\n");
    // The session edits a file governed by the nested rule. A system-reminder is
    // present (context machinery) but the nested rule file is never injected.
    writeFileSync(
      join(dir, "session.jsonl"),
      [
        JSON.stringify({ type: "user", message: { role: "user", content: "<system-reminder>context</system-reminder> edit the schema" } }),
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Edit", input: { file_path: join(dir, "src", "db", "schema.ts"), content: "x" } }] } }),
      ].join("\n")
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function runCapture(args: string[]): { out: string; status: number } {
    try {
      const out = execFileSync("node", [CLI, ...args], { cwd: dir, encoding: "utf-8" });
      return { out, status: 0 };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; status?: number };
      if (typeof e.status !== "number") throw err;
      return { out: `${e.stdout ?? ""}${e.stderr ?? ""}`, status: e.status };
    }
  }

  it("fires the advisory in the HTML yet still exits 0 with 0 not-followed", () => {
    const { out, status } = runCapture(["check", "--transcript", "session.jsonl", "--html"]);
    // The advisory fired in the terminal output...
    expect(out).toContain("edited-rule-not-loaded");
    // ...and in the HTML file...
    const htmlPath = join(dir, "rulereceipt-report.html");
    expect(existsSync(htmlPath)).toBe(true);
    const html = readFileSync(htmlPath, "utf-8");
    expect(html).toContain("Advisory — not a verdict");
    expect(html).toContain("edited-rule-not-loaded");
    // ...but it did NOT flip the exit code or invent a failure.
    expect(status).toBe(0);
    expect(html).toContain("0 not followed");
  });

  it("also fires the advisory in the --timeline HTML, still exit 0", () => {
    const { out, status } = runCapture(["check", "--transcript", "session.jsonl", "--timeline", "tl.html"]);
    expect(out).toContain("edited-rule-not-loaded");
    const tlPath = join(dir, "tl.html");
    expect(existsSync(tlPath)).toBe(true);
    const html = readFileSync(tlPath, "utf-8");
    expect(html).toContain("Advisory — not a verdict");
    expect(html).toContain("edited-rule-not-loaded");
    expect(status).toBe(0);
  });
});
