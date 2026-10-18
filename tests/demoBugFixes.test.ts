import { describe, it, expect } from "vitest";
import { classifyRule } from "../src/checks/classify.js";
import type { Rule } from "../src/types.js";

const mk = (title: string): Rule => ({ id: "r", title, text: "", source: "project", sourceLine: 1 });

// 0.1.114 demo-bug fixes: plain-prose file bans → fileLifecycle; test-gate → claimEvidence.
describe("0.1.114 — plain-prose FILE ban routes to fileLifecycle", () => {
  it("'Never edit .env files.' → fileLifecycle on .env", () => {
    const c = classifyRule(mk("Never edit .env files.")) as { kind: string; filePath?: string };
    expect(c.kind).toBe("fileLifecycle");
    expect(c.filePath).toBe(".env");
  });
  it("'Do not modify config/prod.yaml.' → fileLifecycle on that path", () => {
    const c = classifyRule(mk("Do not modify config/prod.yaml.")) as { kind: string; filePath?: string };
    expect(c.kind).toBe("fileLifecycle");
    expect(c.filePath).toBe("config/prod.yaml");
  });
  it("a READ rule stays judgment (reading is not editing)", () => {
    expect(classifyRule(mk("Always read .env before running.")).kind).toBe("judgment");
  });
  it("a qualifier ('commit secrets to .env') stays judgment, never a file FAIL", () => {
    expect(classifyRule(mk("Never commit secrets to .env.")).kind).toBe("judgment");
  });
  it("'.env.example' is not captured for a '.env' rule (different file) — stays judgment", () => {
    // the rule itself about .env.example routes to judgment; the checker also
    // never matches a .env rule against a .env.example edit (fa-corpus-v6).
    expect(classifyRule(mk("Never edit the .env.example template.")).kind).toBe("judgment");
  });
});

describe("0.1.114 — test-gate rule routes to claimEvidence", () => {
  it("'Run the tests before saying you are done.' → claimEvidence", () => {
    expect(classifyRule(mk("Run the tests before saying you are done.")).kind).toBe("claimEvidence");
  });
  it("'Never say the work is done without running the tests.' → claimEvidence", () => {
    expect(classifyRule(mk("Never say the work is done without running the tests.")).kind).toBe("claimEvidence");
  });
  it("'Write tests for every new module.' does NOT become claimEvidence (it's an edit→test rule)", () => {
    expect(classifyRule(mk("Write tests for every new module.")).kind).not.toBe("claimEvidence");
  });
});
