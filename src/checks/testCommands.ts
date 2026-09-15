import type { TranscriptEvent } from "../types.js";
import { withoutHeredocs } from "./shellCommand.js";

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
 * It can never be complete — projects wire their suite to whatever script
 * name they like — so callers must never let a miss become an accusation.
 * See UNKNOWN_SCRIPT_RUNNER in claimEvidence.ts.
 *
 * Deliberately a known list rather than anything test-shaped. Both callers
 * use it to decide whether to report a FAIL, and a rule that fires because
 * someone ran a script with "test" in its name is the expensive kind of
 * wrong.
 */
export const TEST_COMMAND =
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|verify|check|ci)\b|\bnpx\s+(?:vitest|jest|mocha|ava)\b|\b(?:vitest|jest|mocha|pytest|phpunit|rspec|tox)\b|\bcargo\s+test\b|\bgo\s+test\b|\bmvn\s+(?:test|verify)\b|\bgradle\s+test\b|\bdotnet\s+test\b|\bpython\s+-m\s+(?:pytest|unittest)\b/i;


/**
 * How many times a single shell command invokes a test suite.
 *
 * A command that runs the suite twice has no single outcome to attribute.
 * Real case, 2026-09-14: one command ran a typecheck, then the suite (37
 * passed), then re-ran one file with locking deliberately disabled to
 * demonstrate those tests can fail. The session said "Everything passes:",
 * which was true; the checker read "2 failed" out of the third section and
 * called it a lie.
 *
 * Deliberate red runs cannot be recognised - "is this failure intended" is
 * not in the text. What IS in the text is that the suite ran more than
 * once, and that is enough: the outcome is unattributable for the same
 * reason a pipe makes an exit code unattributable. Heredoc bodies are
 * stripped first, so a command that merely writes a test command twice
 * still counts zero.
 */
export function countTestRuns(command: string): number {
  const global = new RegExp(TEST_COMMAND.source, "gi");
  return (withoutHeredocs(command).match(global) ?? []).length;
}

/** The first test command run in this session, or null if none ran. */
export function findTestRun(events: TranscriptEvent[]): string | null {
  for (const event of events) {
    if (event.kind !== "tool_use") continue;
    const input = event.input as { command?: unknown } | null | undefined;
    const command = input && typeof input.command === "string" ? input.command : "";
    if (command && TEST_COMMAND.test(withoutHeredocs(command))) return command;
  }
  return null;
}

export { withoutHeredocs } from "./shellCommand.js";
