import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capabilityReport, renderCapabilities, companions } from "../src/capabilities.js";

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

  it("names agnix as a complementary companion (file-lint vs behaviour-check)", () => {
    const agnix = companions().find((c) => c.name === "agnix");
    expect(agnix).toBeTruthy();
    expect(agnix!.note).toMatch(/complementary|use both/i);
  });
});

describe("companion detection on PATH", () => {
  const saved = process.env.PATH;
  afterEach(() => { process.env.PATH = saved; });

  it("reports agnix installed when it is on PATH, not when it isn't", () => {
    const dir = mkdtempSync(join(tmpdir(), "rr-path-"));
    try {
      process.env.PATH = "/nonexistent-dir-xyz";
      expect(companions().find((c) => c.name === "agnix")!.installed).toBe(false);
      const bin = join(dir, "agnix");
      writeFileSync(bin, "#!/bin/sh\necho agnix\n");
      chmodSync(bin, 0o755);
      process.env.PATH = dir;
      expect(companions().find((c) => c.name === "agnix")!.installed).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
