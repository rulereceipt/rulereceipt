import { describe, it, expect } from "vitest";
import { buildTeamExport, parseExport, mergeTeamExports, EXPORT_SCHEMA } from "../src/teamExport.js";
import type { CheckResult } from "../src/types.js";

// Conformance test for docs/spec/receipt-v0.md. It encodes the spec's contract so
// the document cannot silently drift from the code: if the emitted shape changes
// in a way the spec doesn't describe, this fails.

const r = (title: string, status: CheckResult["status"], evidence = "", notVisible = false): CheckResult => ({
  ruleId: "1", ruleTitle: title, ruleSource: "project", status, evidence, ...(notVisible ? { notVisible: true } : {}),
});

const STATUSES = ["PASS", "FAIL", "UNCLEAR"];
const SOURCES = ["global", "project"];

/** The spec-v0 contract as a predicate. Throws with the first violation found. */
function assertConformsToV0(o: unknown): void {
  if (!o || typeof o !== "object") throw new Error("not an object");
  const x = o as Record<string, unknown>;
  if (x.kind !== "export") throw new Error("kind must be 'export'");
  if (typeof x.schema !== "number") throw new Error("schema must be an integer");
  if (typeof x.tool !== "string") throw new Error("tool must be a string");
  if (typeof x.version !== "string") throw new Error("version must be a string");
  if (typeof x.dev !== "string") throw new Error("dev must be a string");
  if (typeof x.project !== "string") throw new Error("project must be a string");
  if (typeof x.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(x.date)) throw new Error("date must be YYYY-MM-DD");
  const s = x.summary as Record<string, unknown> | undefined;
  if (!s || ["total", "pass", "fail", "unclear"].some((k) => typeof s[k] !== "number")) throw new Error("summary must have integer total/pass/fail/unclear");
  if (!Array.isArray(x.rules)) throw new Error("rules must be an array");
  for (const e of x.rules as Record<string, unknown>[]) {
    if (typeof e.title !== "string") throw new Error("rule.title must be a string");
    if (!SOURCES.includes(e.source as string)) throw new Error("rule.source must be global|project");
    if (!STATUSES.includes(e.status as string)) throw new Error(`rule.status must be one of ${STATUSES.join("|")}`);
    if (typeof e.evidence !== "string") throw new Error("rule.evidence must be a string");
    if ("notVisible" in e && typeof e.notVisible !== "boolean") throw new Error("rule.notVisible must be a boolean when present");
  }
}

describe("rule-receipt spec v0 — docs/spec/receipt-v0.md", () => {
  it("the real emitter output conforms to the documented contract", () => {
    const e = buildTeamExport(
      [r("Never push to main", "FAIL", 'ran "git push origin main"'), r("Use pnpm", "PASS", "pnpm install"), r("Keep changes small", "UNCLEAR")],
      "my-app", "Ada", "0.1.109", new Date("2026-10-16T09:00:00Z"),
    );
    expect(() => assertConformsToV0(e)).not.toThrow();
    expect(parseExport(JSON.stringify(e))).not.toBeNull();
  });

  it("the spec version in the document matches the code constant", () => {
    // docs/spec/receipt-v0.md states schema: 1; this binds the doc to the code.
    expect(EXPORT_SCHEMA).toBe(1);
    expect(buildTeamExport([], "p", "d", "0.1.109").schema).toBe(EXPORT_SCHEMA);
  });

  it("summary.fail counts broken-and-visible only (a notVisible FAIL is not a break)", () => {
    const e = buildTeamExport([r("Never edit .env", "FAIL", "edited .env", true), r("Never push to main", "FAIL", "git push origin main")], "p", "d", "0.1.109");
    expect(e.summary.fail).toBe(1); // the notVisible FAIL is excluded
    expect(() => assertConformsToV0(e)).not.toThrow();
  });

  it("a reader does not count a notVisible break (merge agrees with the spec)", () => {
    const e = buildTeamExport([r("Never edit .env", "FAIL", "edited .env", true)], "p", "d", "0.1.109");
    const merged = mergeTeamExports([e]);
    expect(merged.totalBroken).toBe(0);
  });

  // Rule 7: the validator must be able to fail. These malformed objects each
  // violate one documented clause and must be rejected.
  it("rejects objects that violate the contract (proves the check has teeth)", () => {
    const base = buildTeamExport([r("x", "PASS", "e")], "p", "d", "0.1.109") as unknown as Record<string, unknown>;
    const bad: Record<string, unknown>[] = [
      { ...base, kind: "report" },
      { ...base, schema: "1" },
      { ...base, date: "October 16" },
      { ...base, summary: { total: 1, pass: 1, fail: 0 } }, // missing unclear
      { ...base, rules: [{ title: "x", source: "project", status: "MAYBE", evidence: "" }] },
      { ...base, rules: [{ title: "x", source: "nowhere", status: "PASS", evidence: "" }] },
      { ...base, rules: [{ title: "x", source: "project", status: "PASS", evidence: "", notVisible: "yes" }] },
    ];
    for (const b of bad) expect(() => assertConformsToV0(b)).toThrow();
  });
});
