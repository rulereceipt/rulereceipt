import { describe, it, expect } from "vitest";
import { generateReport } from "../src/report/generateReport.js";
import type { CheckResult } from "../src/types.js";

const meta = { sessionFilePath: null, ruleCount: 4 };

const mixed: CheckResult[] = [
  { ruleId: "1", ruleTitle: "No console.log in source", ruleSource: "project", status: "FAIL", evidence: "console.log( written into src/app.ts" },
  { ruleId: "2", ruleTitle: "Tests pass before done", ruleSource: "project", status: "PASS", evidence: "npm test ran clean" },
  // path-scoped rule whose covered file was never touched — "Didn't apply", NOT "never loaded"
  { ruleId: "3", ruleTitle: "DB migrations need review", ruleSource: "project", status: "UNCLEAR", outcome: "not_applicable", reason: "path_scope_not_loaded", evidence: "path-scoped rule (src/db/**): this session edited no file it covers, so it didn't apply" },
  // judgment rule
  { ruleId: "4", ruleTitle: "Surface bad news first", ruleSource: "global", status: "UNCLEAR", needsHuman: true, evidence: "" },
];

describe("report grouping (0.1.113): Never loaded → Checked → Not checked", () => {
  it("shows a 'Checked — observable rules' group and a 'Not checked — needs your judgment' group, in that order", () => {
    const out = generateReport(mixed, meta);
    const checked = out.indexOf("Checked — observable rules");
    const notChecked = out.indexOf("Not checked — needs your judgment");
    expect(checked).toBeGreaterThan(-1);
    expect(notChecked).toBeGreaterThan(-1);
    expect(notChecked).toBeGreaterThan(checked);
  });

  it("puts a judgment rule under 'Not checked', never under 'Checked'", () => {
    const out = generateReport(mixed, meta);
    // The judgment rule's title appears AFTER the "Not checked" header.
    expect(out.indexOf("Surface bad news first")).toBeGreaterThan(out.indexOf("Not checked — needs your judgment"));
  });

  it("files a path-scope-untouched rule under 'Didn't apply', and NEVER prints 'Never loaded' for it", () => {
    const out = generateReport(mixed, meta); // no neverLoaded passed
    expect(out).toContain("Didn't apply this session");
    expect(out).not.toContain("Never loaded");
  });

  it("renders a 'Never loaded' group at the very top ONLY when edited-rule-not-loaded titles are passed", () => {
    const out = generateReport(mixed, meta, undefined, ["Never edit .env"]);
    expect(out).toContain("⚠ Never loaded (1)");
    expect(out).toContain("Never edit .env");
    // Top of the body: above the Checked group.
    expect(out.indexOf("⚠ Never loaded")).toBeLessThan(out.indexOf("Checked — observable rules"));
  });
});
