import { describe, it, expect } from "vitest";
import { runCodeContentChecks } from "../src/checks/codeContent.js";
import type { CodeContentClassification } from "../src/checks/classify.js";
import type { TranscriptEvent } from "../src/types.js";

function bash(command: string): TranscriptEvent {
  return { role: "assistant", kind: "tool_use", toolName: "Bash", input: { command }, timestamp: "2026-08-30T00:00:00Z" };
}

function write(filePath: string, content: string): TranscriptEvent {
  return { role: "assistant", kind: "tool_use", toolName: "Write", input: { file_path: filePath, content }, timestamp: "2026-08-30T00:00:00Z" };
}

function edit(filePath: string, newString: string): TranscriptEvent {
  return { role: "assistant", kind: "tool_use", toolName: "Edit", input: { file_path: filePath, new_string: newString }, timestamp: "2026-08-30T00:00:00Z" };
}

function textEvent(text: string): TranscriptEvent {
  return { role: "assistant", kind: "text", text, timestamp: "2026-08-30T00:00:00Z" };
}

function toolResult(content: string): TranscriptEvent {
  return { role: "user", kind: "tool_result", content, isError: false, timestamp: "2026-08-30T00:00:00Z" };
}

const noPrintRule: CodeContentClassification = {
  kind: "codeContent",
  rule: { id: "50", title: "No debug prints", text: "Never leave a `print(` statement in committed code.", source: "project" },
  patterns: ["print("],
  polarity: "forbid",
};

describe("runCodeContentChecks", () => {
  // the exact remaining false positive found on the 2nd real-world test:
  // the agent's OWN Bash command mentioned the pattern as a search
  // argument, and generic deterministic matching counted it
  it("does NOT fail when the pattern appears only as a search ARGUMENT in the agent's own Bash command", () => {
    const events = [bash('grep -rn "print(" src/')];
    const [result] = runCodeContentChecks([noPrintRule], events);
    expect(result.status).toBe("PASS");
  });

  it("does NOT fail when the pattern appears only in prose the agent wrote", () => {
    const events = [textEvent("I noticed a stray print( call in the legacy module, worth cleaning up later.")];
    const [result] = runCodeContentChecks([noPrintRule], events);
    expect(result.status).toBe("PASS");
  });

  it("does NOT fail when the pattern appears only in a tool_result (a file the agent read)", () => {
    const events = [toolResult("def legacy():\n    print('old debug line')\n")];
    const [result] = runCodeContentChecks([noPrintRule], events);
    expect(result.status).toBe("PASS");
  });

  it("correctly FAILs when the pattern is actually written into a file via Write", () => {
    const events = [write("src/new.py", "def f():\n    print('debug')\n")];
    const [result] = runCodeContentChecks([noPrintRule], events);
    expect(result.status).toBe("FAIL");
  });

  it("correctly FAILs when the pattern is actually written into a file via Edit", () => {
    const events = [edit("src/existing.py", "    print('added debug')")];
    const [result] = runCodeContentChecks([noPrintRule], events);
    expect(result.status).toBe("FAIL");
  });

  it("PASSes when file edits happened but none contained the pattern", () => {
    const events = [write("src/clean.py", "def f():\n    return 42\n")];
    const [result] = runCodeContentChecks([noPrintRule], events);
    expect(result.status).toBe("PASS");
  });

  it("PASSes on a completely empty session", () => {
    const [result] = runCodeContentChecks([noPrintRule], []);
    expect(result.status).toBe("PASS");
  });

  it("includes the real written content in the evidence when it FAILs", () => {
    const events = [write("src/new.py", "print('debug value')")];
    const [result] = runCodeContentChecks([noPrintRule], events);
    expect(result.evidence).toContain("print('debug value')");
  });

  // adversarial case from the edge-case list: the same literal appearing
  // in several benign contexts AND one real violation, all in one
  // session — the real one must still be caught, the benign ones ignored
  it("catches a real violation even when the same pattern also appears in benign contexts in the same session", () => {
    const events = [
      bash('grep -rn "print(" src/'),
      textEvent("Checked for stray print( calls."),
      toolResult("legacy.py:  print('old')"),
      write("src/new.py", "print('the actual violation')"),
    ];
    const [result] = runCodeContentChecks([noPrintRule], events);
    expect(result.status).toBe("FAIL");
    expect(result.evidence).toContain("the actual violation");
  });

  describe("require polarity", () => {
    const requireTrackRule: CodeContentClassification = {
      kind: "codeContent",
      rule: { id: "51", title: "Track new features", text: "Always wire `analytics.track(` into new user-facing features.", source: "project" },
      patterns: ["analytics.track("],
      polarity: "require",
    };

    it("PASSes when the required pattern was actually written into a file", () => {
      const events = [write("src/feature.ts", "analytics.track('signup_completed')")];
      const [result] = runCodeContentChecks([requireTrackRule], events);
      expect(result.status).toBe("PASS");
    });

    it("reports UNCLEAR, never a fabricated FAIL, when the required pattern never appears in a real edit", () => {
      const events = [write("src/feature.ts", "function signup() { return true; }")];
      const [result] = runCodeContentChecks([requireTrackRule], events);
      expect(result.status).toBe("UNCLEAR");
    });

    it("does NOT count a mere mention in prose as satisfying a require rule", () => {
      const events = [textEvent("I should probably add analytics.track( here at some point.")];
      const [result] = runCodeContentChecks([requireTrackRule], events);
      expect(result.status).toBe("UNCLEAR");
    });
  });
});
