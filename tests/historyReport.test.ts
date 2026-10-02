import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanHistory, renderHistory, type HistorySummary } from "../src/historyReport.js";
import { claudeCodeAdapter } from "../src/adapters/index.js";
import { loadRules } from "../src/rules.js";

function write(dir: string, name: string, lines: unknown[]): string {
  const p = join(dir, name);
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n"));
  return p;
}

/** Run `fn` with HOME redirected to an empty dir so global ~/.claude rules can't leak in. */
function isolated<T>(fn: () => T): T {
  const prev = process.env.HOME;
  process.env.HOME = mkdtempSync(join(tmpdir(), "rr-hist-home-"));
  try {
    return fn();
  } finally {
    process.env.HOME = prev;
  }
}

describe("history mode aggregation", () => {
  const dir = mkdtempSync(join(tmpdir(), "rr-hist-"));
  writeFileSync(join(dir, ".git"), "");
  writeFileSync(join(dir, "CLAUDE.md"), "## 1. Never push without asking\nNever push without explicit user instruction.\n");

  const pushSession = (mode: string) => [
    { type: "user", timestamp: "2026-09-28T00:00:00Z", permissionMode: mode, message: { role: "user", content: "fix the page" } },
    { type: "assistant", timestamp: "2026-09-28T00:00:01Z", message: { role: "assistant", content: [{ type: "tool_use", id: "a", name: "Bash", input: { command: "git push origin main" } }] } },
    { type: "user", timestamp: "2026-09-28T00:00:02Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "ok" }] } },
  ];
  const cleanSession = [
    { type: "assistant", timestamp: "2026-09-28T00:00:01Z", message: { role: "assistant", content: [{ type: "tool_use", id: "b", name: "Bash", input: { command: "npm test" } }] } },
  ];
  const s1 = write(dir, "s1.jsonl", pushSession("bypassPermissions"));
  const s2 = write(dir, "s2.jsonl", cleanSession);
  const sessions = [
    { adapter: claudeCodeAdapter, file: s1 },
    { adapter: claudeCodeAdapter, file: s2 },
  ];

  it("aggregates proven breaks across all sessions in the window", async () => {
    const summary = await isolated(async () => scanHistory(dir, loadRules(dir), 30, Date.now(), sessions));
    expect(summary.sessionsScanned).toBe(2);
    expect(summary.breaks).toHaveLength(1);
    expect(summary.breaks[0].ruleTitle.toLowerCase()).toContain("never push");
    expect(summary.breaks[0].count).toBe(1);
    expect(summary.totalBrokenCount).toBe(1);
    expect(summary.breaks[0].quote.length).toBeGreaterThan(0);
  });

  it("excludes sessions older than the window", async () => {
    // days = 0 → cutoff is now, so freshly-written fixtures fall outside it
    const summary = await isolated(async () => scanHistory(dir, loadRules(dir), 0, Date.now() + 10_000_000, sessions));
    expect(summary.sessionsScanned).toBe(0);
  });
});

describe("history render", () => {
  const base: HistorySummary = {
    sessionsScanned: 2, days: 30, tools: ["claude-code"],
    breaks: [{ ruleId: "1", ruleTitle: "Never push without asking", ruleSource: "project", count: 3, lastMs: Date.now(), quote: 'ran "git push origin main" with no approval' }],
    totalBrokenCount: 3, followedRules: 9, judgmentRules: 14, notVisibleRules: 0, elapsedMs: 1800,
  };

  it("leads with the proven-break count and shows the quote + timing", () => {
    const out = renderHistory(base, "my-app");
    expect(out).toContain("Claude broke your rules 3 times");
    expect(out).toContain("Never push without asking");
    expect(out).toContain("git push origin main");
    expect(out).toContain("9 rules followed every time");
    expect(out).toContain("14 need");
    expect(out).toContain("checked 2 sessions in 1.8s");
    expect(out).toContain("last: today");
  });

  it("no sessions → a helpful message, not an empty screen", () => {
    const out = renderHistory({ ...base, sessionsScanned: 0, tools: [], breaks: [], totalBrokenCount: 0, followedRules: 0, judgmentRules: 0 }, "x");
    expect(out.toLowerCase()).toContain("no coding-agent sessions found");
  });

  it("the footer points to protect (ask first) and card (share)", () => {
    const out = renderHistory(base, "my-app");
    expect(out).toContain("rulereceipt protect");
    expect(out).toContain("rulereceipt card");
  });

  it("never overstates: the headline counts only proven breaks, judgment is separate", () => {
    const out = renderHistory(base, "x");
    // the big number is 3 (proven), not 3+14
    expect(out).toContain("broke your rules 3 times");
    expect(out).not.toContain("17");
  });
});
