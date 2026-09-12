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

  describe("non-testable files (docs/config) never count as needing a test (real false-positive found 2026-08-30)", () => {
    it("does NOT fail when only a markdown documentation file was edited", () => {
      const events = [edit("README.md")];
      const [result] = runIfEditThenTestChecks([rule], events);
      expect(result.status).toBe("UNCLEAR");
    });

    it("does NOT fail when only JSON/YAML config files were edited", () => {
      const events = [edit("package.json"), edit("config.yaml")];
      const [result] = runIfEditThenTestChecks([rule], events);
      expect(result.status).toBe("UNCLEAR");
    });

    it("still correctly FAILs on a real code file even when a doc file was ALSO edited without a test", () => {
      const events = [edit("src/foo.ts"), edit("README.md")];
      const [result] = runIfEditThenTestChecks([rule], events);
      expect(result.status).toBe("FAIL");
      expect(result.evidence).toContain("src/foo.ts");
      expect(result.evidence).not.toContain("README.md");
    });

    it("still correctly PASSes when a real code file has a matching test, regardless of docs also being edited", () => {
      const events = [edit("src/foo.ts"), edit("src/foo.test.ts"), edit("README.md")];
      const [result] = runIfEditThenTestChecks([rule], events);
      expect(result.status).toBe("PASS");
    });
  });
});

/**
 * Running the suite is honouring an "add tests for every change" rule just
 * as much as touching a test file is.
 *
 * Real false positives found 2026-09-11 by running every rule in the
 * 559-file corpus against one synthetic session — edit a source file, run
 * `npm test` (12 passed), commit. Twelve rules came back FAIL saying "no
 * matching test file was touched". The session had run the tests. FAIL is
 * the most expensive verdict this tool produces, and this one was reachable
 * by the most ordinary workflow there is: change code, run the suite.
 *
 * Both independent reviews of the checker design flagged exactly this —
 * pair on "the project's test script ran", not only on "a test file was
 * written".
 */
describe("a test RUN satisfies an edit-implies-test rule", () => {
  const rule = {
    kind: "ifEditThenTest" as const,
    rule: { id: "1", title: "Add tests for every change", text: "Write tests for any code you change.", source: "project" as const },
  };
  const bash = (c: string): TranscriptEvent => ({
    role: "assistant", kind: "tool_use", toolName: "Bash", input: { command: c }, timestamp: "2026-09-11T00:00:00Z",
  });

  it("does not FAIL when the suite was run after the edit", () => {
    const [r] = runIfEditThenTestChecks([rule], [edit("src/app.ts"), bash("npm test")]);
    expect(r.status).not.toBe("FAIL");
  });

  it("recognises runners other than npm", () => {
    for (const cmd of ["pytest -q", "cargo test", "go test ./...", "npx vitest run", "pnpm test"]) {
      const [r] = runIfEditThenTestChecks([rule], [edit("src/app.ts"), bash(cmd)]);
      expect(r.status, `missed runner: ${cmd}`).not.toBe("FAIL");
    }
  });

  it("says WHY it passed, naming the command", () => {
    const [r] = runIfEditThenTestChecks([rule], [edit("src/app.ts"), bash("npm test")]);
    expect(r.evidence).toMatch(/npm test/);
  });

  it("still FAILS when code changed and nothing tested it at all", () => {
    // The case the rule actually exists for must keep failing.
    const [r] = runIfEditThenTestChecks([rule], [edit("src/app.ts"), bash("git commit -m wip")]);
    expect(r.status).toBe("FAIL");
  });

  it("does not count an unrelated command as a test run", () => {
    const [r] = runIfEditThenTestChecks([rule], [edit("src/app.ts"), bash("npm run build")]);
    expect(r.status).toBe("FAIL");
  });
});
