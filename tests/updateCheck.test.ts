import { describe, it, expect, afterEach } from "vitest";
import { isUpdateCheckEnabled, shouldCheckNow, renderUpdateNudge } from "../src/updateCheck.js";

/**
 * The update check is opt-in and must stay that way. These pin: it is off
 * unless asked, it rate-limits itself, and it only nudges when a newer
 * version actually exists.
 */

describe("isUpdateCheckEnabled — off unless opted in", () => {
  const orig = process.env.RULERECEIPT_CHECK_UPDATES;
  afterEach(() => {
    if (orig === undefined) delete process.env.RULERECEIPT_CHECK_UPDATES;
    else process.env.RULERECEIPT_CHECK_UPDATES = orig;
  });

  it("off by default (no flag, no env)", () => {
    delete process.env.RULERECEIPT_CHECK_UPDATES;
    expect(isUpdateCheckEnabled(false)).toBe(false);
  });
  it("on with the flag", () => {
    delete process.env.RULERECEIPT_CHECK_UPDATES;
    expect(isUpdateCheckEnabled(true)).toBe(true);
  });
  it("on with the env var", () => {
    process.env.RULERECEIPT_CHECK_UPDATES = "1";
    expect(isUpdateCheckEnabled(false)).toBe(true);
  });
});

describe("shouldCheckNow — rate limited", () => {
  const DAY = 24 * 60 * 60 * 1000;
  it("checks when never checked before", () => {
    expect(shouldCheckNow(1_000_000, null)).toBe(true);
  });
  it("does not check again within the interval", () => {
    const now = 1_000_000_000;
    expect(shouldCheckNow(now, now - DAY / 2)).toBe(false);
  });
  it("checks again after the interval", () => {
    const now = 1_000_000_000;
    expect(shouldCheckNow(now, now - DAY - 1)).toBe(true);
  });
});

describe("renderUpdateNudge", () => {
  it("nudges when a newer version exists", () => {
    const out = renderUpdateNudge("0.1.45", "0.1.46");
    expect(out).toContain("v0.1.46");
    expect(out).toContain("npx rulereceipt@latest");
  });
  it("says nothing when already latest", () => {
    expect(renderUpdateNudge("0.1.46", "0.1.46")).toBeNull();
  });
  it("says nothing when local is newer (0.1.10 vs 0.1.9, numeric)", () => {
    expect(renderUpdateNudge("0.1.10", "0.1.9")).toBeNull();
  });
});
