import { describe, it, expect } from "vitest";
import { verifyReceipt, parseReceipt } from "../src/receipt.js";

/**
 * The CI gate. These pin the pass/fail decision: a real, current, passing
 * receipt is accepted; a failing, malformed, future-schema, or stale one is
 * rejected. UNCLEAR alone never rejects (same rule as `check`'s exit code).
 */

function receipt(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    tool: "rulereceipt",
    schema: 1,
    version: "0.1.45",
    generatedAt: new Date().toISOString(),
    session: { path: "/x", sha256: "abc" },
    summary: { total: 3, pass: 2, fail: 0, unclear: 1 },
    results: [],
    ...over,
  });
}

describe("parseReceipt", () => {
  it("accepts a well-formed receipt", () => {
    expect(parseReceipt(receipt()).error).toBeUndefined();
  });
  it("rejects non-JSON", () => {
    expect(parseReceipt("not json {").error).toMatch(/not valid JSON/);
  });
  it("rejects something that isn't a rulereceipt receipt", () => {
    expect(parseReceipt(JSON.stringify({ tool: "somethingelse" })).error).toMatch(/not a rulereceipt receipt/);
  });
  it("rejects a receipt missing summary counts", () => {
    expect(parseReceipt(JSON.stringify({ tool: "rulereceipt", schema: 1, generatedAt: "x" })).error).toMatch(/summary/);
  });
});

describe("verifyReceipt", () => {
  it("accepts a current passing receipt", () => {
    const r = verifyReceipt(receipt());
    expect(r.ok).toBe(true);
    expect(r.problems).toEqual([]);
  });

  it("rejects when a rule FAILED", () => {
    const r = verifyReceipt(receipt({ summary: { total: 3, pass: 1, fail: 2, unclear: 0 } }));
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toMatch(/2 rules FAILED/);
  });

  it("does NOT reject on UNCLEAR alone", () => {
    const r = verifyReceipt(receipt({ summary: { total: 3, pass: 0, fail: 0, unclear: 3 } }));
    expect(r.ok).toBe(true);
  });

  it("rejects a receipt whose schema is newer than this tool", () => {
    const r = verifyReceipt(receipt({ schema: 2 }));
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toMatch(/schema 2 is newer/);
  });

  it("rejects a stale receipt under --max-age-days", () => {
    const old = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const r = verifyReceipt(receipt({ generatedAt: old }), { maxAgeDays: 7 });
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toMatch(/days old/);
  });

  it("accepts a fresh receipt under --max-age-days", () => {
    expect(verifyReceipt(receipt(), { maxAgeDays: 7 }).ok).toBe(true);
  });
});

describe("session re-verification (the trustless path)", () => {
  it("no session provided = trust mode: ok, not sessionVerified", () => {
    const r = verifyReceipt(receipt()); // receipt()'s session.sha256 is "abc"
    expect(r.ok).toBe(true);
    expect(r.sessionVerified).toBeUndefined();
  });

  it("matching session hash: ok AND sessionVerified", () => {
    const r = verifyReceipt(receipt(), { sessionHash: "abc" });
    expect(r.ok).toBe(true);
    expect(r.sessionVerified).toBe(true);
  });

  it("mismatched session hash is REJECTED (forged/wrong session)", () => {
    const r = verifyReceipt(receipt(), { sessionHash: "different" });
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toMatch(/does NOT match the provided session/);
  });

  it("unreadable session (null) is rejected", () => {
    const r = verifyReceipt(receipt(), { sessionHash: null });
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toMatch(/could not be read/);
  });

  it("session provided but receipt has no hash (demo data) is rejected", () => {
    const r = verifyReceipt(receipt({ session: { path: null, sha256: null } }), { sessionHash: "abc" });
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toMatch(/no session hash/);
  });
});
