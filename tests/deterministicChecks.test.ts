import { describe, it, expect } from "vitest";
import { runDeterministicChecks } from "../src/checks/deterministicChecks.js";
import type { DeterministicClassification } from "../src/checks/classify.js";
import type { TranscriptEvent } from "../src/types.js";

function toolUse(toolName: string, input: unknown): TranscriptEvent {
  return { role: "assistant", kind: "tool_use", toolName, input, timestamp: "2026-08-16T00:00:00Z" };
}

const rule: DeterministicClassification = {
  kind: "deterministic",
  rule: { id: "5", title: "No force push", text: "Never run `git push --force`.", source: "project" },
  patterns: ["git push --force"],
  polarity: "forbid",
};

describe("runDeterministicChecks", () => {
  it("FAILs when the banned pattern actually appears in a tool call", () => {
    const events = [toolUse("Bash", { command: "git push --force origin main" })];
    const [result] = runDeterministicChecks([rule], events);
    expect(result.status).toBe("FAIL");
  });

  it("includes the actual matched text in the evidence, not a generic message", () => {
    const events = [toolUse("Bash", { command: "git push --force origin main" })];
    const [result] = runDeterministicChecks([rule], events);
    expect(result.evidence).toContain("git push --force");
  });

  it("PASSes when the pattern never appears", () => {
    const events = [toolUse("Bash", { command: "git push origin main" })];
    const [result] = runDeterministicChecks([rule], events);
    expect(result.status).toBe("PASS");
  });

  it("PASSes on a completely empty session (nothing to violate)", () => {
    const [result] = runDeterministicChecks([rule], []);
    expect(result.status).toBe("PASS");
  });

  it("checks non-Bash tool calls too, not just Bash", () => {
    const events = [toolUse("Write", { content: "run: git push --force later" })];
    const [result] = runDeterministicChecks([rule], events);
    expect(result.status).toBe("FAIL");
  });

  // this is the exact false-positive that failed before the word-boundary
  // fix in deterministicChecks.ts — "--force-with-lease" is the SAFE
  // variant and must not be flagged as the banned bare "--force"
  it("does NOT false-positive on --force-with-lease, the safe variant", () => {
    const events = [toolUse("Bash", { command: "git push --force-with-lease origin main" })];
    const [result] = runDeterministicChecks([rule], events);
    expect(result.status).toBe("PASS");
  });

  // Real bug found while building a security-focused CLAUDE.md template:
  // a pattern ending in punctuation (like a URL scheme) could never match
  // a real occurrence, because the old trailing word-boundary check
  // unconditionally required "not followed by a word character" — but a
  // real URL always has a domain (word characters) immediately after
  // "http://". Confirmed false-negative by hand before writing this fix.
  it("matches a pattern ending in punctuation even when real text follows immediately (http:// bug)", () => {
    const urlRule: DeterministicClassification = {
      kind: "deterministic",
      rule: { id: "11", title: "No plain HTTP", text: "Never use `http://`.", source: "project" },
      patterns: ["http://"],
      polarity: "forbid",
    };
    const events = [toolUse("Write", { content: 'const url = "http://api.example.com/data";' })];
    const [result] = runDeterministicChecks([urlRule], events);
    expect(result.status).toBe("FAIL");
  });

  it("still applies the word-boundary check when the pattern ends in a word character (regression guard)", () => {
    // --force must still NOT match inside --force-with-lease, same as before
    const events = [toolUse("Bash", { command: "git push --force-with-lease origin main" })];
    const [result] = runDeterministicChecks([rule], events);
    expect(result.status).toBe("PASS");
  });

  // Security audit flagged that an extreme pattern length might crash
  // regex construction. Direct empirical test (not theory): even a
  // 200,000-char pattern must not crash the whole check, and must stay
  // fast — regardless of whether it throws or not, a bad pattern must
  // never take down every other rule in the report.
  describe("require polarity (new: previously every deterministic rule was forbid-only)", () => {
    const requireRule: DeterministicClassification = {
      kind: "deterministic",
      rule: { id: "20", title: "Must run tests", text: "Always run `npm test` before committing.", source: "project" },
      patterns: ["npm test"],
      polarity: "require",
    };

    it("PASSes when the required pattern actually appears", () => {
      const events = [toolUse("Bash", { command: "npm test" })];
      const [result] = runDeterministicChecks([requireRule], events);
      expect(result.status).toBe("PASS");
    });

    it("reports UNCLEAR, never a fabricated FAIL or PASS, when the required pattern never appears", () => {
      const events = [toolUse("Bash", { command: "git commit -m done" })];
      const [result] = runDeterministicChecks([requireRule], events);
      expect(result.status).toBe("UNCLEAR");
    });

    it("reports UNCLEAR on a completely empty session too (can't tell if it applied)", () => {
      const [result] = runDeterministicChecks([requireRule], []);
      expect(result.status).toBe("UNCLEAR");
    });
  });

  it("does not crash and stays fast on a pathologically long rule pattern", () => {
    const hugePattern = "a".repeat(200_000);
    const hugeRule: DeterministicClassification = {
      kind: "deterministic",
      rule: { id: "99", title: "Extreme pattern", text: `Never do \`${hugePattern}\`.`, source: "project" },
      patterns: [hugePattern],
      polarity: "forbid",
    };
    const start = Date.now();
    const [result] = runDeterministicChecks([hugeRule], [toolUse("Bash", { command: "echo hi" })]);
    const elapsedMs = Date.now() - start;
    expect(["PASS", "UNCLEAR"]).toContain(result.status);
    expect(elapsedMs).toBeLessThan(1000);
  });
});
