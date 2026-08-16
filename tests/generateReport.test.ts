import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateReport, generateMarkdownReport, computeTranscriptHash } from "../src/report/generateReport.js";
import type { CheckResult } from "../src/types.js";

const results: CheckResult[] = [
  { ruleId: "1", ruleTitle: "Evidence or it didn't happen", status: "PASS", evidence: "showed real output" },
  { ruleId: "4", ruleTitle: "Surface bad news first", status: "FAIL", evidence: "led with good news" },
  { ruleId: "9", ruleTitle: "Unanswered questions carry forward", status: "UNCLEAR", evidence: "no prior question in scope" },
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
});

describe("generateMarkdownReport", () => {
  it("produces a valid-looking markdown table with a header row", () => {
    const output = generateMarkdownReport(results, { sessionFilePath: null, ruleCount: 3 });
    expect(output).toContain("| Status | Rule | Evidence |");
  });

  it("escapes pipe characters in evidence so the table doesn't break", () => {
    const withPipe: CheckResult[] = [{ ruleId: "1", ruleTitle: "x", status: "PASS", evidence: "a | b" }];
    const output = generateMarkdownReport(withPipe, { sessionFilePath: null, ruleCount: 1 });
    expect(output).toContain("a \\| b");
  });

  // proves this test can fail: an unescaped pipe WOULD break the table
  it("FAILS if pipe escaping is removed (sanity check on the test itself)", () => {
    const withPipe: CheckResult[] = [{ ruleId: "1", ruleTitle: "x", status: "PASS", evidence: "a | b" }];
    const output = generateMarkdownReport(withPipe, { sessionFilePath: null, ruleCount: 1 });
    expect(output).not.toContain("| a | b |"); // the raw unescaped form
  });
});
