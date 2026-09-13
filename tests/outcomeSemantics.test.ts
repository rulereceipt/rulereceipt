import { describe, it, expect } from "vitest";
import { runDeterministicChecks } from "../src/checks/deterministicChecks.js";
import { runFileLifecycleChecks } from "../src/checks/fileLifecycle.js";
import type { TranscriptEvent } from "../src/types.js";

/**
 * The vocabulary, as specified on anthropics/claude-code#90542:
 *
 *   not_run         you never evaluated this rule's trigger.
 *                   May NOT mean "the rule did not apply".
 *   not_applicable  the trigger WAS evaluated and returned no.
 *                   May NOT mean "I didn't happen to see a Write".
 *   fail            trigger yes, obligation broken, inside the ceiling.
 *
 * A first attempt at this shipped a session-activity guard — "did any tool
 * call happen" — that emitted not_applicable. That is a compiled trigger
 * wearing a ratified word: it claims a trigger was evaluated when none was.
 * The correct source of not_applicable is the rule's own trigger check,
 * which every checker already performs, so the proxy is not needed at all.
 *
 * For a prohibition the trigger IS the forbidden act. Evaluated and absent
 * means the rule never applied, not that it was followed. That distinction
 * is what turned 2,770 empty-session green ticks into something honest.
 */
const bash = (command: string): TranscriptEvent => ({
  role: "assistant", kind: "tool_use", toolName: "Bash", input: { command }, timestamp: "t",
});
const write = (p: string): TranscriptEvent => ({
  role: "assistant", kind: "tool_use", toolName: "Write", input: { file_path: p }, timestamp: "t",
});

const forbidRule = {
  kind: "deterministic" as const,
  rule: { id: "1", title: "No force pushing", text: "Never run `git push --force`.", source: "project" as const },
  patterns: ["git push --force"],
  polarity: "forbid" as const,
};

describe("a prohibition whose act never happened did not apply", () => {
  it("reports not_applicable, not pass, when the forbidden act is absent", () => {
    const [r] = runDeterministicChecks([forbidRule], [bash("npm test")]);
    expect(r.outcome).toBe("not_applicable");
  });

  it("reports not_applicable on an empty session too", () => {
    const [r] = runDeterministicChecks([forbidRule], []);
    expect(r.outcome).toBe("not_applicable");
  });

  it("never reports fail from an absence", () => {
    const [r] = runDeterministicChecks([forbidRule], []);
    expect(r.status).not.toBe("FAIL");
  });

  it("still flags the act when it does happen", () => {
    const [r] = runDeterministicChecks([forbidRule], [bash("git push --force origin main")]);
    expect(r.outcome).not.toBe("not_applicable");
  });

  it("carries a ceiling saying what the method could establish", () => {
    const [r] = runDeterministicChecks([forbidRule], [bash("npm test")]);
    expect(r.ceiling).toBeTruthy();
    expect(r.ceiling).toMatch(/text scan|spelling|not proof/i);
  });
});

describe("a session-activity proxy may not claim not_applicable", () => {
  const protect = {
    kind: "fileLifecycle" as const,
    rule: { id: "1", title: "Protect settings", text: "Never modify `.claude/settings.json`.", source: "project" as const },
    filePath: ".claude/settings.json",
    polarity: "forbid" as const,
  };

  it("a Bash rm of the protected file is trigger=yes, not 'nothing happened'", () => {
    // The exact case the first version got wrong: an activity guard keyed on
    // Write/Edit labelled this "this rule never applied".
    const [r] = runFileLifecycleChecks([protect], [bash("rm -f .claude/settings.json")]);
    expect(r.outcome).not.toBe("not_applicable");
    expect(r.status).toBe("FAIL");
  });

  it("an untouched protected file is not_applicable, from the real trigger check", () => {
    const [r] = runFileLifecycleChecks([protect], [write("src/other.ts")]);
    expect(r.outcome).toBe("not_applicable");
  });
});
