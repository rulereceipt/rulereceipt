import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { renderPrComment } from "../src/prComment.js";
import type { Receipt } from "../src/receipt.js";

function receipt(results: Receipt["results"], over: Partial<Receipt> = {}): Receipt {
  const r = results as { status?: string; notVisible?: boolean }[];
  const fail = r.filter((x) => x.status === "FAIL" && !x.notVisible).length;
  return {
    tool: "rulereceipt",
    schema: 1,
    version: "0.1.109",
    generatedAt: "2026-10-16T09:00:00.000Z",
    session: { path: null, sha256: "abc" },
    summary: { total: r.length, pass: r.filter((x) => x.status === "PASS").length, fail, unclear: r.filter((x) => x.status === "UNCLEAR").length },
    results,
    ...over,
  };
}

describe("renderPrComment — display-only PR comment from a receipt", () => {
  it("lists broken rules first, with a marker and one evidence line", () => {
    const md = renderPrComment(receipt([
      { ruleTitle: "Use pnpm", status: "PASS", evidence: "pnpm install" },
      { ruleTitle: "Never push to main", status: "FAIL", evidence: "git push origin main" },
    ]));
    expect(md).toContain("**Broken (1)**");
    expect(md).toContain("Never push to main");
    expect(md).toContain("git push origin main");
    // Broken section comes before the Followed section.
    expect(md.indexOf("Never push to main")).toBeLessThan(md.indexOf("Use pnpm"));
    // Header counts what the receipt says.
    expect(md).toContain("1 broken · 1 followed · 0 can't tell");
  });

  it("does NOT count a notVisible FAIL as broken (same rule as everywhere)", () => {
    const md = renderPrComment(receipt([
      { ruleTitle: "Never edit .env", status: "FAIL", notVisible: true, evidence: "edited .env" },
    ]));
    expect(md).toContain("0 broken");
    expect(md).toContain("No rules were broken");
    expect(md).toContain("weren't loaded into the session's context");
    expect(md).not.toContain("**Broken (");
  });

  it("redacts secrets / home paths / emails in evidence (a PR comment is public)", () => {
    // Build the home path from the real homedir so this exercises the redactor
    // on every machine (a hard-coded path only matches homedir on one box, and
    // passed locally but failed in CI — the redactor masks os.homedir(), not an
    // arbitrary /Users/<name>).
    const home = homedir();
    const md = renderPrComment(receipt([
      { ruleTitle: "No secrets", status: "FAIL", evidence: `cat ${home}/.env  # me@example.com` },
    ]));
    if (home && home.length > 1) {
      expect(md).not.toContain(`${home}/.env`);
      expect(md).toContain("~/.env");
    }
    expect(md).not.toContain("me@example.com");
  });

  it("collapses multi-line evidence to a single capped line", () => {
    const long = "line one is here\nline two should be dropped";
    const md = renderPrComment(receipt([{ ruleTitle: "x", status: "FAIL", evidence: long }]));
    expect(md).toContain("line one is here");
    expect(md).not.toContain("line two should be dropped");
  });

  it("handles an all-clear receipt and an empty receipt without crashing", () => {
    expect(renderPrComment(receipt([{ ruleTitle: "ok", status: "PASS", evidence: "did it" }]))).toContain("No rules were broken");
    expect(renderPrComment(receipt([]))).toContain("0 broken");
  });

  it("groups judgment/unclear rules as can't-tell, not as broken or followed", () => {
    const md = renderPrComment(receipt([
      { ruleTitle: "Keep changes small", status: "UNCLEAR", evidence: "", needsHuman: true },
    ]));
    expect(md).toContain("1 rule can't be told");
    expect(md).toContain("0 broken · 0 followed · 1 can't tell");
  });
});
