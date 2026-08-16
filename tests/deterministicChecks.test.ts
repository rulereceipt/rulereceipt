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
});
