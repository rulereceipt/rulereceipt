import { describe, it, expect } from "vitest";
import { buildTeamExport, parseExport, mergeTeamExports, renderTeamHtml } from "../src/teamExport.js";
import type { CheckResult } from "../src/types.js";

const r = (title: string, status: CheckResult["status"], evidence = ""): CheckResult => ({
  ruleId: "1", ruleTitle: title, ruleSource: "project", status, evidence,
});

describe("buildTeamExport — shareable, no transcript, no absolute paths", () => {
  it("carries verdicts + evidence, a dev, a project basename and counts", () => {
    const e = buildTeamExport([r("Never push to main", "FAIL", 'ran "git push origin main"'), r("Clean code", "UNCLEAR")], "my-app", "Ada", "0.1.79", new Date("2026-10-02T09:00:00Z"));
    expect(e.project).toBe("my-app");
    expect(e.dev).toBe("Ada");
    expect(e.date).toBe("2026-10-02");
    expect(e.summary).toEqual({ total: 2, pass: 0, fail: 1, unclear: 1 });
    expect(e.rules[0]).toEqual({ title: "Never push to main", source: "project", status: "FAIL", evidence: 'ran "git push origin main"' });
    // The whole serialized export must not leak an absolute path or raw transcript.
    const json = JSON.stringify(e);
    expect(json).not.toMatch(/\/Users\/|\/home\/|sessionFilePath|transcript/);
  });
  it("falls back to 'unknown' when no dev name is given", () => {
    expect(buildTeamExport([], "p", "   ", "0.1.79").dev).toBe("unknown");
  });
});

describe("parseExport", () => {
  it("accepts a real export and rejects anything else", () => {
    const e = buildTeamExport([r("x", "PASS")], "p", "d", "0.1.79");
    expect(parseExport(JSON.stringify(e))?.project).toBe("p");
    expect(parseExport("{not json")).toBeNull();
    expect(parseExport('{"tool":"something-else"}')).toBeNull();
  });
});

describe("mergeTeamExports — rules broken most, by whom, trend", () => {
  const ada = buildTeamExport([r("Never push to main", "FAIL"), r("Run tests", "FAIL")], "app", "Ada", "0.1.79", new Date("2026-10-01T00:00:00Z"));
  const ben = buildTeamExport([r("Never push to main", "FAIL"), r("Run tests", "PASS")], "app", "Ben", "0.1.79", new Date("2026-10-02T00:00:00Z"));

  it("aggregates breaks across devs with who broke what, and a day trend", () => {
    const m = mergeTeamExports([ada, ben]);
    expect(m.devs).toEqual(["Ada", "Ben"]);
    expect(m.totalBroken).toBe(3);
    expect(m.broken[0]).toEqual({ title: "Never push to main", count: 2, devs: ["Ada", "Ben"] });
    expect(m.broken[1]).toEqual({ title: "Run tests", count: 1, devs: ["Ada"] });
    expect(m.trend).toEqual([{ date: "2026-10-01", broken: 2 }, { date: "2026-10-02", broken: 1 }]);
  });

  it("renders a self-contained HTML (no external scripts/styles) with the names and the label", () => {
    const html = renderTeamHtml(mergeTeamExports([ada, ben]));
    expect(html).toContain("team preview");
    expect(html).toContain("Never push to main");
    expect(html).toContain("Ada");
    // Local-only: no CDN, no remote fetch.
    expect(html).not.toMatch(/https?:\/\/|cdn\.|src=|fetch\(/);
  });
});
