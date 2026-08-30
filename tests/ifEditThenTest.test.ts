import { describe, it, expect } from "vitest";
import { runIfEditThenTestChecks } from "../src/checks/ifEditThenTest.js";
import type { IfEditThenTestClassification } from "../src/checks/classify.js";
import type { TranscriptEvent } from "../src/types.js";

function edit(filePath: string): TranscriptEvent {
  return { role: "assistant", kind: "tool_use", toolName: "Edit", input: { file_path: filePath }, timestamp: "2026-08-30T00:00:00Z" };
}

function textEvent(text: string): TranscriptEvent {
  return { role: "assistant", kind: "text", text, timestamp: "2026-08-30T00:00:00Z" };
}

const rule: IfEditThenTestClassification = {
  kind: "ifEditThenTest",
  rule: { id: "1", title: "Tests required", text: "Every change needs a test.", source: "project" },
};

describe("runIfEditThenTestChecks", () => {
  it("FAILs (skipped) when a prod file is edited with no matching test file", () => {
    const events = [edit("src/foo.ts")];
    const [result] = runIfEditThenTestChecks([rule], events);
    expect(result.status).toBe("FAIL");
  });

  it("PASSes (followed) when both a prod file and a test file are edited", () => {
    const events = [edit("src/foo.ts"), edit("src/foo.test.ts")];
    const [result] = runIfEditThenTestChecks([rule], events);
    expect(result.status).toBe("PASS");
  });

  it("reports UNCLEAR on a completely empty session (rule never had a chance to apply)", () => {
    const [result] = runIfEditThenTestChecks([rule], []);
    expect(result.status).toBe("UNCLEAR");
  });

  it("does NOT count assistant chat text claiming 'I added tests' as evidence — only real tool_use edits count", () => {
    const events = [edit("src/foo.ts"), textEvent("I added tests for this in src/foo.test.ts, all passing now.")];
    const [result] = runIfEditThenTestChecks([rule], events);
    expect(result.status).toBe("FAIL");
  });

  it("recognizes __tests__/ directory style test files, not just .test. suffix", () => {
    const events = [edit("src/foo.ts"), edit("src/__tests__/foo.ts")];
    const [result] = runIfEditThenTestChecks([rule], events);
    expect(result.status).toBe("PASS");
  });

  it("recognizes .spec. style test files", () => {
    const events = [edit("src/foo.ts"), edit("src/foo.spec.ts")];
    const [result] = runIfEditThenTestChecks([rule], events);
    expect(result.status).toBe("PASS");
  });

  it("ignores tool_use events from tools other than Write/Edit/NotebookEdit", () => {
    const events: TranscriptEvent[] = [
      { role: "assistant", kind: "tool_use", toolName: "Read", input: { file_path: "src/foo.ts" }, timestamp: "2026-08-30T00:00:00Z" },
    ];
    const [result] = runIfEditThenTestChecks([rule], events);
    // a Read is not an edit, so this should behave like no edits happened
    expect(result.status).toBe("UNCLEAR");
  });
});
