import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { auditSessions, renderComplianceReport } from "../src/report/complianceReport.js";
import type { ComplianceReport } from "../src/report/complianceReport.js";

const homeState = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  homeState.current = actual.homedir();
  return { ...actual, homedir: () => homeState.current };
});

const toolUse = (command: string) =>
  JSON.stringify({
    type: "assistant", timestamp: "2026-09-20T00:00:00Z",
    message: { content: [{ type: "tool_use", name: "Bash", id: "t1", input: { command } }] },
  });

describe("renderComplianceReport", () => {
  const rep: ComplianceReport = {
    sessionsChecked: 3, sessionsWithViolations: 1, totalViolations: 2, ruleCount: 10,
    byRule: [{ title: "Never push to main", count: 2 }],
    sessions: [{
      session: "abc123def456", when: "2026-09-20", events: 4,
      violations: [
        { ruleId: "1", ruleTitle: "Never push to main", ruleSource: "project", status: "FAIL", evidence: "ran git push origin main" },
      ],
    }],
  };
  it("summarises counts, top rules, and per-session evidence", () => {
    const out = renderComplianceReport(rep);
    expect(out).toContain("Checked 3 sessions");
    expect(out).toContain("1 of 3 sessions had at least one policy violation");
    expect(out).toContain("Never push to main");
    expect(out).toContain("ran git push origin main");
    expect(out).toContain("abc123def456".slice(0, 12));
  });
});

describe("auditSessions aggregates violations across many sessions", () => {
  let home: string;
  let project: string;
  const realHome = homeState.current;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "rr-cr-home-"));
    project = mkdtempSync(join(tmpdir(), "rr-cr-proj-"));
    homeState.current = home;
    mkdirSync(join(project, ".git"));
    writeFileSync(
      join(project, "CLAUDE.md"),
      "# Rules\n\n## 1. Never delete the ledger\nNever run `rm` on `data/ledger.db`.\n"
    );
    const enc = project.replace(/\//g, "-");
    const dir = join(home, ".claude", "projects", enc);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "s1.jsonl"), toolUse("rm data/ledger.db"));   // violates
    writeFileSync(join(dir, "s2.jsonl"), toolUse("git status"));          // clean
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
    homeState.current = realHome;
  });

  it("flags the violating session and leaves the clean one alone", async () => {
    const r = await auditSessions(project, 25);
    expect(r.sessionsChecked).toBe(2);
    expect(r.sessionsWithViolations).toBe(1);
    expect(r.totalViolations).toBeGreaterThanOrEqual(1);
    expect(r.byRule.some((x) => /ledger/i.test(x.title))).toBe(true);
  });
});
