import { describe, it, expect } from "vitest";
import { compareVersions, highlightsBetween, renderWhatsNew, type Release } from "../src/whatsNew.js";

/**
 * The "what's new" footer shows a returning user what improved since they
 * last ran, once per update. The risky logic is which releases to show and
 * the version compare (0.1.9 must sort before 0.1.10). The file I/O around
 * it is thin and fails open; the decision is tested here.
 */

const REL: Release[] = [
  { version: "0.1.44", highlights: ["gate offer"] },
  { version: "0.1.43", highlights: ["read/verify check"] },
  { version: "0.1.41", highlights: ["emoji properly"] },
  { version: "0.1.10", highlights: ["ten"] },
  { version: "0.1.9", highlights: ["nine"] },
];

describe("compareVersions", () => {
  it("is numeric, not lexical (0.1.9 < 0.1.10)", () => {
    expect(compareVersions("0.1.9", "0.1.10")).toBeLessThan(0);
    expect(compareVersions("0.1.10", "0.1.9")).toBeGreaterThan(0);
  });
  it("orders and equals correctly", () => {
    expect(compareVersions("0.1.44", "0.1.43")).toBeGreaterThan(0);
    expect(compareVersions("0.1.44", "0.1.44")).toBe(0);
  });
});

describe("highlightsBetween", () => {
  it("shows nothing on the first run ever (no last-seen)", () => {
    expect(highlightsBetween(null, "0.1.44", REL)).toEqual([]);
  });

  it("shows only releases newer than last-seen, up to current", () => {
    const got = highlightsBetween("0.1.41", "0.1.44", REL).map((r) => r.version);
    expect(got).toEqual(["0.1.44", "0.1.43"]);
  });

  it("shows nothing when already on the latest seen", () => {
    expect(highlightsBetween("0.1.44", "0.1.44", REL)).toEqual([]);
  });

  it("never shows a downgrade (last-seen newer than current)", () => {
    expect(highlightsBetween("0.1.50", "0.1.44", REL)).toEqual([]);
  });

  it("sorts the 0.1.9 -> 0.1.10 boundary numerically", () => {
    const got = highlightsBetween("0.1.9", "0.1.10", REL).map((r) => r.version);
    expect(got).toEqual(["0.1.10"]);
  });
});

describe("renderWhatsNew", () => {
  it("includes each version and its highlight, and the update hint", () => {
    const out = renderWhatsNew([{ version: "0.1.44", highlights: ["gate offer"] }], "0.1.44");
    expect(out).toContain("v0.1.44");
    expect(out).toContain("gate offer");
    expect(out).toContain("npx rulereceipt@latest");
  });
});
