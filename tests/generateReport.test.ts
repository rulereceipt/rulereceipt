import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateReport, generateMarkdownReport, computeTranscriptHash } from "../src/report/generateReport.js";
import type { CheckResult } from "../src/types.js";

const results: CheckResult[] = [
  { ruleId: "1", ruleTitle: "Evidence or it didn't happen", ruleSource: "global", status: "PASS", evidence: "showed real output" },
  { ruleId: "4", ruleTitle: "Surface bad news first", ruleSource: "global", status: "FAIL", evidence: "led with good news" },
  { ruleId: "9", ruleTitle: "Unanswered questions carry forward", ruleSource: "global", status: "UNCLEAR", evidence: "no prior question in scope" },
];

describe("computeTranscriptHash", () => {
  it("returns null, not a throw, when there's no session file", () => {
    expect(computeTranscriptHash(null)).toBeNull();
  });

  it("returns the SAME hash for the same real file content (reproducibility is the whole point)", () => {
    const dir = mkdtempSync(join(tmpdir(), "rulereceipt-test-"));
    const file = join(dir, "session.jsonl");
    writeFileSync(file, '{"type":"user","message":{"content":"hi"}}\n');
    const hashA = computeTranscriptHash(file);
    const hashB = computeTranscriptHash(file);
    expect(hashA).toBe(hashB);
  });

  it("returns a DIFFERENT hash if the file content changes even slightly", () => {
    const dir = mkdtempSync(join(tmpdir(), "rulereceipt-test-"));
    const file = join(dir, "session.jsonl");
    writeFileSync(file, '{"type":"user","message":{"content":"hi"}}\n');
    const hashBefore = computeTranscriptHash(file);
    writeFileSync(file, '{"type":"user","message":{"content":"hi!"}}\n');
    const hashAfter = computeTranscriptHash(file);
    expect(hashBefore).not.toBe(hashAfter);
  });
});

describe("generateReport (terminal)", () => {
  it("includes every rule's status and evidence", () => {
    const output = generateReport(results, { sessionFilePath: null, ruleCount: 3 });
    expect(output).toContain("Rule 4");
    expect(output).toContain("led with good news");
  });

  it("includes an accurate pass/fail/unclear summary count", () => {
    const output = generateReport(results, { sessionFilePath: null, ruleCount: 3 });
    expect(output).toContain("1 pass · 1 fail · 1 unclear");
  });

  it("clearly labels demo/no-file state rather than showing a fake hash", () => {
    const output = generateReport(results, { sessionFilePath: null, ruleCount: 3 });
    expect(output).toContain("demo data");
  });

  // real bug found while testing: a project-level CLAUDE.md can reuse the
  // same rule number as the global one — the report must disambiguate,
  // not silently show two indistinguishable "Rule 1" lines
  it("disambiguates by source when two rules share the same ID", () => {
    const colliding: CheckResult[] = [
      { ruleId: "1", ruleTitle: "Global rule one", ruleSource: "global", status: "PASS", evidence: "a" },
      { ruleId: "1", ruleTitle: "Project rule one", ruleSource: "project", status: "FAIL", evidence: "b" },
    ];
    const output = generateReport(colliding, { sessionFilePath: null, ruleCount: 2 });
    expect(output).toContain("Rule 1 (global)");
    expect(output).toContain("Rule 1 (project)");
  });

  it("does NOT add a source label when there's no collision (common case stays clean)", () => {
    const output = generateReport(results, { sessionFilePath: null, ruleCount: 3 });
    expect(output).not.toContain("(global)");
  });

  // security audit finding: a malicious/compromised CLAUDE.md could embed
  // raw ANSI escape codes in a rule title to spoof what the terminal shows
  // (fake colors, cursor tricks). \x1b (ESC) must never reach the output.
  it("strips ANSI escape codes from rule titles before printing", () => {
    const hostile: CheckResult[] = [
      { ruleId: "1", ruleTitle: "\x1b[31mFAKE RED\x1b[0m Injected", ruleSource: "global", status: "PASS", evidence: "clean" },
    ];
    const output = generateReport(hostile, { sessionFilePath: null, ruleCount: 1 });
    expect(output).not.toContain("\x1b");
    expect(output).toContain("Injected");
  });

  it("strips ANSI escape codes from evidence text too, not just titles", () => {
    const hostile: CheckResult[] = [
      { ruleId: "1", ruleTitle: "clean title", ruleSource: "global", status: "PASS", evidence: "\x1b[2K\x1b[1Ghidden cursor trick" },
    ];
    const output = generateReport(hostile, { sessionFilePath: null, ruleCount: 1 });
    expect(output).not.toContain("\x1b");
    expect(output).toContain("hidden cursor trick");
  });

  it("keeps real newlines in multi-line evidence (only control chars are stripped, not \\n)", () => {
    const multiline: CheckResult[] = [
      { ruleId: "1", ruleTitle: "clean", ruleSource: "global", status: "PASS", evidence: "line one\nline two" },
    ];
    const output = generateReport(multiline, { sessionFilePath: null, ruleCount: 1 });
    expect(output).toContain("line one\nline two");
  });
});

describe("generateMarkdownReport", () => {
  it("produces a valid-looking markdown table with a header row", () => {
    const output = generateMarkdownReport(results, { sessionFilePath: null, ruleCount: 3 });
    expect(output).toContain("| Status | Rule | Evidence |");
  });

  it("escapes pipe characters in evidence so the table doesn't break", () => {
    const withPipe: CheckResult[] = [{ ruleId: "1", ruleTitle: "x", ruleSource: "global", status: "PASS", evidence: "a | b" }];
    const output = generateMarkdownReport(withPipe, { sessionFilePath: null, ruleCount: 1 });
    expect(output).toContain("a \\| b");
  });

  // proves this test can fail: an unescaped pipe WOULD break the table
  it("FAILS if pipe escaping is removed (sanity check on the test itself)", () => {
    const withPipe: CheckResult[] = [{ ruleId: "1", ruleTitle: "x", ruleSource: "global", status: "PASS", evidence: "a | b" }];
    const output = generateMarkdownReport(withPipe, { sessionFilePath: null, ruleCount: 1 });
    expect(output).not.toContain("| a | b |"); // the raw unescaped form
  });
});

/**
 * Markdown table escaping. The original escaped only `|`, which broke a
 * real table three ways — CodeQL flagged the backslash case
 * (js/incomplete-sanitization); the unescaped rule title and the
 * unhandled newline were found while fixing it. All three come from a
 * user's own CLAUDE.md or their session text, so none are hypothetical.
 */
describe("markdown table cells cannot be broken by rule or evidence content", () => {
  function md(over: Partial<CheckResult>): string {
    const r: CheckResult = {
      ruleId: "1",
      ruleTitle: "A rule",
      ruleSource: "project",
      status: "PASS",
      evidence: "some evidence",
      ...over,
    };
    return generateMarkdownReport([r], { sessionFilePath: null, ruleCount: 1 });
  }

  /**
   * Counts real column separators the way a markdown renderer does: a `|`
   * is a separator unless preceded by an ODD number of backslashes.
   *
   * A naive /(?<!\\)\|/ is wrong here, and wrong in the exact case that
   * matters — it treats the `|` in `\\|` as escaped when a renderer sees
   * an escaped BACKSLASH followed by a live separator. That blind spot
   * made this suite pass against the very bug CodeQL reported, which is
   * why the red run for this fix was run before trusting it.
   */
  function separatorsInDataRow(markdown: string): number {
    const row = markdown.split("\n").find((l) => l.startsWith("| ") && !l.startsWith("|---") && !l.includes("Status |"));
    if (!row) throw new Error("no data row found");
    let count = 0;
    let backslashes = 0;
    for (const ch of row) {
      if (ch === "\\") backslashes++;
      else {
        if (ch === "|" && backslashes % 2 === 0) count++;
        backslashes = 0;
      }
    }
    return count;
  }
  const pipesInDataRow = separatorsInDataRow;

  it("escapes a backslash before a pipe, so the row is not split", () => {
    expect(pipesInDataRow(md({ evidence: "matched \\| in a regex" }))).toBe(4);
  });

  it("escapes a pipe in the RULE TITLE, not only in evidence", () => {
    expect(pipesInDataRow(md({ ruleTitle: "Never run `cat x | sh`" }))).toBe(4);
  });

  it("keeps a newline in evidence from ending the table row", () => {
    const out = md({ evidence: "line one\nline two" });
    expect(pipesInDataRow(out)).toBe(4);
    expect(out).toContain("<br>");
  });

  it("survives all three at once", () => {
    expect(pipesInDataRow(md({ ruleTitle: "a | b", evidence: "x \\| y\nz | w" }))).toBe(4);
  });
});
