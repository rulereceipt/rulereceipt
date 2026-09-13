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
    // name says it must not accuse; that is the guarantee, and a rule
      // whose trigger never fired is not_applicable rather than followed
      expect(result.status).not.toBe("FAIL");
  });

  it("does NOT fail when the protected file is only read via the Read tool", () => {
    const events = [read(".claude/settings.json")];
    const [result] = runFileLifecycleChecks([protectSettings], events);
    // name says it must not accuse; that is the guarantee, and a rule
      // whose trigger never fired is not_applicable rather than followed
      expect(result.status).not.toBe("FAIL");
  });

  it("does NOT fail when the path is only grepped", () => {
    const events = [bash("grep -n hooks .claude/settings.json")];
    const [result] = runFileLifecycleChecks([protectSettings], events);
    // name says it must not accuse; that is the guarantee, and a rule
      // whose trigger never fired is not_applicable rather than followed
      expect(result.status).not.toBe("FAIL");
  });

  it("does NOT fail when the path appears only in prose", () => {
    const events = [textEvent("I checked .claude/settings.json and it looks untouched.")];
    const [result] = runFileLifecycleChecks([protectSettings], events);
    expect(result.status).not.toBe("FAIL");
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
    // name says it must not accuse; that is the guarantee, and a rule
      // whose trigger never fired is not_applicable rather than followed
      expect(result.status).not.toBe("FAIL");
  });

  it("reports an empty session as never having applied, not as followed", () => {
    // CHANGED 2026-09-12. This asserted PASS. A rule whose situation never
    // arose was being counted as followed, which is how an empty transcript
    // produced 2,770 green ticks across the 559-file corpus — every one true
    // and none of them meaning anything. The guarantee that still matters is
    // that it never accuses, and that is asserted here too.
    const [result] = runFileLifecycleChecks([protectSettings], []);
    expect(result.outcome).toBe("not_applicable");
    expect(result.status).not.toBe("FAIL");
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

/**
 * A scratch file is not the project's file.
 *
 * Found 2026-09-13 by adjudicating the last structured failures by hand. A
 * rule saying "CHANGELOG.md is release-only" fired on
 * /private/tmp/.../scratchpad/CHANGELOG.md — a throwaway written during a
 * probe and deleted minutes later. The same exclusion already existed in
 * ifEditThenTest for exactly this reason and was never applied here.
 */
describe("temp and scratch paths are not the project's protected files", () => {
  const protectChangelog = {
    kind: "fileLifecycle" as const,
    rule: { id: "1", title: "Changelog is release-only", text: "Never hand-edit `CHANGELOG.md`.", source: "project" as const },
    filePath: "CHANGELOG.md",
    polarity: "forbid" as const,
  };
  const edit = (p: string): TranscriptEvent =>
    ({ role: "assistant", kind: "tool_use", toolName: "Edit", input: { file_path: p }, timestamp: "t" });

  it("does not fire on a scratchpad copy", () => {
    const [r] = runFileLifecycleChecks([protectChangelog], [edit("/private/tmp/claude-501/abc/scratchpad/CHANGELOG.md")]);
    expect(r.status).not.toBe("FAIL");
  });

  it("does not fire on other throwaway locations", () => {
    for (const p of ["/tmp/CHANGELOG.md", "node_modules/pkg/CHANGELOG.md", "dist/CHANGELOG.md"]) {
      const [r] = runFileLifecycleChecks([protectChangelog], [edit(p)]);
      expect(r.status, `should not fire on ${p}`).not.toBe("FAIL");
    }
  });

  it("still fires on the project's own file", () => {
    const [r] = runFileLifecycleChecks([protectChangelog], [edit("CHANGELOG.md")]);
    expect(r.status).toBe("FAIL");
  });

  it("still fires on the project's file in a subdirectory", () => {
    const [r] = runFileLifecycleChecks([protectChangelog], [edit("docs/CHANGELOG.md")]);
    expect(r.status).toBe("FAIL");
  });
});

describe("a shell mutation inside a temp directory is still a temp file", () => {
  const protectClaude = {
    kind: "fileLifecycle" as const,
    rule: { id: "1", title: "Never commit under .claude/", text: "Never commit changes under `.claude/`.", source: "project" as const },
    filePath: ".claude/",
    polarity: "forbid" as const,
  };
  const bash = (command: string): TranscriptEvent =>
    ({ role: "assistant", kind: "tool_use", toolName: "Bash", input: { command }, timestamp: "t" });

  it("does not fire on a scratch tree built under /tmp", () => {
    // Verbatim from a real session. The command is MULTI-LINE: `cd /tmp` on
    // the first line, the .claude write three lines later. A guard that
    // looks for a temp prefix adjacent to the filename cannot connect them,
    // which is why a shortened one-line fixture passed while the real
    // command still failed.
    const real = [
      "cd /tmp && rm -rf loadgap && mkdir -p loadgap/.claude && cd loadgap",
      "CLI=/Users/shilpa/Desktop/Shilpa/rulereceipt/dist/cli.js",
      "printf '# Root\\n\\n## 1. Root rule\\n' > .claude/CLAUDE.md",
      "node $CLI check",
    ].join("\n");
    const [r] = runFileLifecycleChecks([protectClaude], [bash(real)]);
    expect(r.status).not.toBe("FAIL");
  });

  it("still fires on a real deletion in the project", () => {
    const [r] = runFileLifecycleChecks([protectClaude], [bash("rm -rf .claude/")]);
    expect(r.status).toBe("FAIL");
  });
});
