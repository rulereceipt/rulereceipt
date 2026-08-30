import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isTelemetryDisabled } from "../src/telemetry.js";

// getOrCreateTelemetryId/sendTelemetryPing touch the real filesystem
// (~/.rulereceipt/telemetry-id) and the real network — same reasoning as
// emailConfig.ts's save/load functions, which are excluded from unit tests
// for the same reason. isTelemetryDisabled is the pure, meaningfully
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

describe("isTelemetryDisabled", () => {
  it("is NOT disabled by default (no flag, no env vars)", () => {
    expect(isTelemetryDisabled(false)).toBe(false);
  });

  it("is disabled when the --no-telemetry flag is passed", () => {
    expect(isTelemetryDisabled(true)).toBe(true);
  });

  it("respects the cross-tool DO_NOT_TRACK=1 convention", () => {
    process.env.DO_NOT_TRACK = "1";
    expect(isTelemetryDisabled(false)).toBe(true);
  });

  it("respects DO_NOT_TRACK=true", () => {
    process.env.DO_NOT_TRACK = "true";
    expect(isTelemetryDisabled(false)).toBe(true);
  });

  it("respects the project-specific RULERECEIPT_NO_TELEMETRY=1", () => {
    process.env.RULERECEIPT_NO_TELEMETRY = "1";
    expect(isTelemetryDisabled(false)).toBe(true);
  });

  // proves this can actually fail: an unrelated or malformed env value
  // must NOT be treated as an opt-out
  it("does NOT disable telemetry for an unrelated DO_NOT_TRACK value", () => {
    process.env.DO_NOT_TRACK = "0";
    expect(isTelemetryDisabled(false)).toBe(false);
  });

  it("does NOT disable telemetry for a random RULERECEIPT_NO_TELEMETRY value", () => {
    process.env.RULERECEIPT_NO_TELEMETRY = "nah";
    expect(isTelemetryDisabled(false)).toBe(false);
  });
});
