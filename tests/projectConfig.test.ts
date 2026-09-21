import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProjectConfig, blockingFailures, warningFailures } from "../src/projectConfig.js";
import type { CheckResult } from "../src/types.js";

const R = (id: string, status: CheckResult["status"]): CheckResult =>
  ({ ruleId: id, ruleTitle: `rule ${id}`, ruleSource: "project", status, evidence: "" });

// handle-for stub: the handle is just "h" + ruleId
const handleFor = (r: CheckResult) => `h${r.ruleId}`;

describe("severity split", () => {
  const results = [R("1", "FAIL"), R("2", "FAIL"), R("3", "PASS")];

  it("a warn-listed FAIL is a warning, not a blocker", () => {
    const cfg = { warn: ["h1"] };
    expect(blockingFailures(results, cfg, handleFor).map((r) => r.ruleId)).toEqual(["2"]);
    expect(warningFailures(results, cfg, handleFor).map((r) => r.ruleId)).toEqual(["1"]);
  });

  it("with no warnings configured, every FAIL blocks", () => {
    const cfg = { warn: [] };
    expect(blockingFailures(results, cfg, handleFor).map((r) => r.ruleId)).toEqual(["1", "2"]);
    expect(warningFailures(results, cfg, handleFor)).toEqual([]);
  });

  it("PASS is never a blocker or a warning", () => {
    const cfg = { warn: ["h3"] };
    expect(blockingFailures(results, cfg, handleFor).some((r) => r.ruleId === "3")).toBe(false);
    expect(warningFailures(results, cfg, handleFor).some((r) => r.ruleId === "3")).toBe(false);
  });
});

describe("loadProjectConfig", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rr-cfg-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("loads warn handles from .rulereceipt/config.json", () => {
    mkdirSync(join(dir, ".rulereceipt"));
    writeFileSync(join(dir, ".rulereceipt", "config.json"), JSON.stringify({ warn: ["a", "b"] }));
    expect(loadProjectConfig(dir).warn).toEqual(["a", "b"]);
  });

  it("returns empty warn when there is no config (fail open)", () => {
    expect(loadProjectConfig(dir)).toEqual({ warn: [] });
  });

  it("returns empty warn on a malformed config, never throws", () => {
    mkdirSync(join(dir, ".rulereceipt"));
    writeFileSync(join(dir, ".rulereceipt", "config.json"), "not json {");
    expect(loadProjectConfig(dir)).toEqual({ warn: [] });
  });

  it("ignores non-string entries in warn", () => {
    mkdirSync(join(dir, ".rulereceipt"));
    writeFileSync(join(dir, ".rulereceipt", "config.json"), JSON.stringify({ warn: ["a", 3, null, "b"] }));
    expect(loadProjectConfig(dir).warn).toEqual(["a", "b"]);
  });
});
