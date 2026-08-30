import { describe, it, expect } from "vitest";
import { runFileLifecycleChecks } from "../src/checks/fileLifecycle.js";
import type { FileLifecycleClassification } from "../src/checks/classify.js";
import type { TranscriptEvent } from "../src/types.js";

function bash(command: string): TranscriptEvent {
  return { role: "assistant", kind: "tool_use", toolName: "Bash", input: { command }, timestamp: "2026-08-30T00:00:00Z" };
}

function write(filePath: string): TranscriptEvent {
  return { role: "assistant", kind: "tool_use", toolName: "Write", input: { file_path: filePath, content: "x" }, timestamp: "2026-08-30T00:00:00Z" };
}

function read(filePath: string): TranscriptEvent {
  return { role: "assistant", kind: "tool_use", toolName: "Read", input: { file_path: filePath }, timestamp: "2026-08-30T00:00:00Z" };
}

function textEvent(text: string): TranscriptEvent {
  return { role: "assistant", kind: "text", text, timestamp: "2026-08-30T00:00:00Z" };
}

const protectSettings: FileLifecycleClassification = {
  kind: "fileLifecycle",
  rule: { id: "60", title: "Never touch settings", text: "Never modify `.claude/settings.json`.", source: "project" },
  filePath: ".claude/settings.json",
  polarity: "forbid",
};

describe("runFileLifecycleChecks", () => {
  // the exact real false positive: `cat` to VERIFY the file was intact
  // got reported as the file being touched
  it("does NOT fail when the protected file is only READ with cat", () => {
    const events = [bash("cat .claude/settings.json")];
    const [result] = runFileLifecycleChecks([protectSettings], events);
    expect(result.status).toBe("PASS");
  });

  it("does NOT fail when the protected file is only read via the Read tool", () => {
    const events = [read(".claude/settings.json")];
    const [result] = runFileLifecycleChecks([protectSettings], events);
    expect(result.status).toBe("PASS");
  });

  it("does NOT fail when the path is only grepped", () => {
    const events = [bash("grep -n hooks .claude/settings.json")];
    const [result] = runFileLifecycleChecks([protectSettings], events);
    expect(result.status).toBe("PASS");
  });

  it("does NOT fail when the path appears only in prose", () => {
    const events = [textEvent("I checked .claude/settings.json and it looks untouched.")];
    const [result] = runFileLifecycleChecks([protectSettings], events);
    expect(result.status).toBe("PASS");
  });

  it("correctly FAILs when the file is actually written via the Write tool", () => {
    const events = [write(".claude/settings.json")];
    const [result] = runFileLifecycleChecks([protectSettings], events);
    expect(result.status).toBe("FAIL");
  });

  it("correctly FAILs on an absolute path that ends in the protected path", () => {
    const events = [write("/Users/someone/project/.claude/settings.json")];
    const [result] = runFileLifecycleChecks([protectSettings], events);
    expect(result.status).toBe("FAIL");
  });

  it("correctly FAILs when the file is deleted with rm", () => {
    const events = [bash("rm .claude/settings.json")];
    const [result] = runFileLifecycleChecks([protectSettings], events);
    expect(result.status).toBe("FAIL");
  });

  it("correctly FAILs when the file is overwritten by a redirect", () => {
    const events = [bash('echo "{}" > .claude/settings.json')];
    const [result] = runFileLifecycleChecks([protectSettings], events);
    expect(result.status).toBe("FAIL");
  });

  it("correctly FAILs on an in-place sed edit", () => {
    const events = [bash("sed -i '' 's/a/b/' .claude/settings.json")];
    const [result] = runFileLifecycleChecks([protectSettings], events);
    expect(result.status).toBe("FAIL");
  });

  it("does NOT fail when a DIFFERENT file with a similar name is modified", () => {
    const events = [write(".claude/other-settings.json"), bash("rm backup-settings.json")];
    const [result] = runFileLifecycleChecks([protectSettings], events);
    expect(result.status).toBe("PASS");
  });

  it("PASSes on a completely empty session", () => {
    const [result] = runFileLifecycleChecks([protectSettings], []);
    expect(result.status).toBe("PASS");
  });

  // adversarial: reads AND an unrelated write AND one real mutation
  it("catches a real mutation even when the file was also read benignly in the same session", () => {
    const events = [
      bash("cat .claude/settings.json"),
      textEvent("Verified settings look fine."),
      write("src/other.ts"),
      bash("rm .claude/settings.json"),
    ];
    const [result] = runFileLifecycleChecks([protectSettings], events);
    expect(result.status).toBe("FAIL");
    expect(result.evidence).toContain("rm .claude/settings.json");
  });

  describe("require polarity", () => {
    const requireChangelog: FileLifecycleClassification = {
      kind: "fileLifecycle",
      rule: { id: "61", title: "Update the changelog", text: "Always update `CHANGELOG.md` when changing behavior.", source: "project" },
      filePath: "CHANGELOG.md",
      polarity: "require",
    };

    it("PASSes when the required file was actually updated", () => {
      const events = [write("CHANGELOG.md")];
      const [result] = runFileLifecycleChecks([requireChangelog], events);
      expect(result.status).toBe("PASS");
    });

    it("reports UNCLEAR, never a fabricated FAIL, when the required file was never modified", () => {
      const events = [write("src/thing.ts")];
      const [result] = runFileLifecycleChecks([requireChangelog], events);
      expect(result.status).toBe("UNCLEAR");
    });

    it("does NOT count merely READING the required file as satisfying it", () => {
      const events = [bash("cat CHANGELOG.md")];
      const [result] = runFileLifecycleChecks([requireChangelog], events);
      expect(result.status).toBe("UNCLEAR");
    });
  });
});
