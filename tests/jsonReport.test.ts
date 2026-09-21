import { describe, it, expect } from "vitest";
import { generateJsonReport } from "../src/report/generateReport.js";
import type { CheckResult } from "../src/types.js";

/**
 * `--json` is a contract other tools parse (CI, the GitHub Action, SARIF).
 * These lock the shape: valid JSON, a versioned schema, honest counts, the
 * full hash, and the same control-char sanitization every other output gets.
 */

const RESULTS: CheckResult[] = [
  { ruleId: "1", ruleTitle: "Never commit to main", ruleSource: "project", status: "FAIL", evidence: "committed to main at abc123", method: "code_construct" as never, outcome: "violated" as never },
  { ruleId: "2", ruleTitle: "Surface bad news first", ruleSource: "global", status: "UNCLEAR", evidence: "no API key", needsHuman: true },
  { ruleId: "3", ruleTitle: "Run tests", ruleSource: "project", status: "PASS", evidence: "ran npm test" },
];

const META = { sessionFilePath: null, ruleCount: 3 };

describe("generateJsonReport", () => {
  it("emits valid, parseable JSON", () => {
    expect(() => JSON.parse(generateJsonReport(RESULTS, META, "9.9.9"))).not.toThrow();
  });

  it("carries a versioned schema, tool name, and tool version", () => {
    const j = JSON.parse(generateJsonReport(RESULTS, META, "9.9.9"));
    expect(j.tool).toBe("rulereceipt");
    expect(j.schema).toBe(1);
    expect(j.version).toBe("9.9.9");
  });

  it("summary counts match the results", () => {
    const j = JSON.parse(generateJsonReport(RESULTS, META, "9.9.9"));
    expect(j.summary).toEqual({ total: 3, pass: 1, fail: 1, unclear: 1 });
  });

  it("maps every result with its fields", () => {
    const j = JSON.parse(generateJsonReport(RESULTS, META, "9.9.9"));
    expect(j.results).toHaveLength(3);
    expect(j.results[0]).toMatchObject({ ruleId: "1", status: "FAIL", ruleSource: "project" });
    expect(j.results[1]).toMatchObject({ status: "UNCLEAR", needsHuman: true });
  });

  it("session.sha256 is null for demo/no-session data", () => {
    const j = JSON.parse(generateJsonReport(RESULTS, META, "9.9.9"));
    expect(j.session.sha256).toBeNull();
  });

  it("strips control characters from untrusted rule text (no terminal-injection through JSON)", () => {
    const evil: CheckResult[] = [
      { ruleId: "1", ruleTitle: "bad\u001b[31mred", ruleSource: "project", status: "PASS", evidence: "x\u0007y" },
    ];
    const j = JSON.parse(generateJsonReport(evil, META, "9.9.9"));
    expect(j.results[0].ruleTitle).not.toContain("\u001b");
    expect(j.results[0].evidence).not.toContain("\u0007");
  });
});
