import type { TranscriptEvent } from "../types.js";

/**
 * Commands that run a project's test suite.
 *
 * One definition, imported by every checker that needs it. Two checkers
 * now ask "did the tests run" — claimEvidence, to see whether a claim of a
 * passing suite had anything behind it, and ifEditThenTest, to see whether
 * changed code was exercised. Two copies of this list would drift, and the
 * drift would show up as one checker contradicting the other in the same
 * report.
 *
 * Deliberately a known list rather than anything test-shaped. Both callers
 * use it to decide whether to report a FAIL, and a rule that fires because
 * someone ran a script with "test" in its name is the expensive kind of
 * wrong.
 */
export const TEST_COMMAND =
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\bnpx\s+(?:vitest|jest|mocha|ava)\b|\b(?:vitest|jest|mocha|pytest|phpunit|rspec|tox)\b|\bcargo\s+test\b|\bgo\s+test\b|\bmvn\s+(?:test|verify)\b|\bgradle\s+test\b|\bdotnet\s+test\b|\bpython\s+-m\s+(?:pytest|unittest)\b/i;

/** The first test command run in this session, or null if none ran. */
export function findTestRun(events: TranscriptEvent[]): string | null {
  for (const event of events) {
    if (event.kind !== "tool_use") continue;
    const input = event.input as { command?: unknown } | null | undefined;
    const command = input && typeof input.command === "string" ? input.command : "";
    if (command && TEST_COMMAND.test(command)) return command;
  }
  return null;
}
