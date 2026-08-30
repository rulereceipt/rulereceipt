import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isTelemetryEnabled } from "../src/telemetry.js";

// getOrCreateTelemetryId/sendTelemetryPing touch the real filesystem
// (~/.rulereceipt/telemetry-id) and the real network — same reasoning as
// emailConfig.ts's save/load functions, which are excluded from unit tests
// for the same reason. isTelemetryEnabled is the pure, meaningfully
// testable logic, and it's also the part that determines whether a real
// user's data ever gets sent at all — the highest-stakes part to get right.

const ENV_KEYS = ["DO_NOT_TRACK", "RULERECEIPT_NO_TELEMETRY"] as const;
const originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

describe("isTelemetryEnabled", () => {
  // real reversal, 2026-08-30: telemetry shipped default-on for a few hours,
  // then was reverted to opt-in before any real install base existed — see
  // src/telemetry.ts for why. This is now the load-bearing test: telemetry
  // must NEVER fire without an explicit --telemetry flag.
  it("is OFF by default (no flag, no env vars) — opt-in, not opt-out", () => {
    expect(isTelemetryEnabled(false)).toBe(false);
  });

  it("is ON when the --telemetry flag is explicitly passed", () => {
    expect(isTelemetryEnabled(true)).toBe(true);
  });

  it("DO_NOT_TRACK=1 overrides an explicit --telemetry flag back off", () => {
    process.env.DO_NOT_TRACK = "1";
    expect(isTelemetryEnabled(true)).toBe(false);
  });

  it("DO_NOT_TRACK=true overrides an explicit --telemetry flag back off", () => {
    process.env.DO_NOT_TRACK = "true";
    expect(isTelemetryEnabled(true)).toBe(false);
  });

  it("RULERECEIPT_NO_TELEMETRY=1 overrides an explicit --telemetry flag back off", () => {
    process.env.RULERECEIPT_NO_TELEMETRY = "1";
    expect(isTelemetryEnabled(true)).toBe(false);
  });

  // proves this can actually fail: an unrelated or malformed env value
  // must NOT be treated as an override
  it("does NOT override the flag for an unrelated DO_NOT_TRACK value", () => {
    process.env.DO_NOT_TRACK = "0";
    expect(isTelemetryEnabled(true)).toBe(true);
  });

  it("does NOT override the flag for a random RULERECEIPT_NO_TELEMETRY value", () => {
    process.env.RULERECEIPT_NO_TELEMETRY = "nah";
    expect(isTelemetryEnabled(true)).toBe(true);
  });
});
