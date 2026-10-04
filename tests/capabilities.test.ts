import { describe, it, expect } from "vitest";
import { capabilityReport, renderCapabilities } from "../src/capabilities.js";

describe("capability matrix", () => {
  const r = capabilityReport();

  it("marks claude-code supported and validated", () => {
    const cc = r.agents.find((a) => a.tool === "claude-code");
    expect(cc?.read).toBe("full");
    expect(cc?.validated).toBe(true);
  });

  it("marks codex readable but NOT yet validated (in testing), consistent with README/KNOWN-GAPS", () => {
    const cx = r.agents.find((a) => a.tool === "codex");
    expect(cx?.read).toBe("full");
    expect(cx?.validated).toBe(false);
    expect(cx?.note).toMatch(/in testing/i);
  });

  it("states guard limits (never empty — the honesty is the point)", () => {
    expect(r.guardLimits.length).toBeGreaterThan(0);
    expect(renderCapabilities(r)).toMatch(/CANNOT catch/);
  });

  it("does not claim an experimental adapter is validated", () => {
    for (const a of r.agents.filter((x) => x.read === "experimental")) expect(a.validated).toBe(false);
  });
});
