import { describe, it, expect } from "vitest";
import { detectShadowSignals } from "../src/checks/shadowSignals.js";
import type { TranscriptEvent } from "../src/types.js";

const bash = (command: string, id = "c"): TranscriptEvent => ({ role: "assistant", kind: "tool_use", toolName: "Bash", toolUseId: id, input: { command }, timestamp: "t" });
const result = (content: string, id = "c"): TranscriptEvent => ({ role: "user", kind: "tool_result", toolUseId: id, content, isError: false, timestamp: "t" });
const say = (text: string): TranscriptEvent => ({ role: "assistant", kind: "text", text, timestamp: "t" });
const edit = (file_path: string): TranscriptEvent => ({ role: "assistant", kind: "tool_use", toolName: "Edit", input: { file_path, content: "x" }, timestamp: "t" });
const has = (events: TranscriptEvent[]) => detectShadowSignals([], events).map((f) => f.signal).includes("unproven-claim");
const count = (events: TranscriptEvent[]) => detectShadowSignals([], events).filter((f) => f.signal === "unproven-claim").length;
const write = (file_path: string): TranscriptEvent => ({ role: "assistant", kind: "tool_use", toolName: "Write", input: { file_path, content: "x" }, timestamp: "t" });

describe("shadow: unproven-claim (advisory — no matching run after the last edit)", () => {
  it("FIRES: edited, then 'all tests pass' with no test run", () => {
    expect(has([edit("/p/app.ts"), say("All tests pass, the feature is done.")])).toBe(true);
  });
  it("FIRES: edited, then 'the build passes' with no build run", () => {
    expect(has([edit("/p/app.ts"), say("The build passes now.")])).toBe(true);
  });
  it("FIRES: CI output shows a FAILURE after the edit (not success evidence)", () => {
    expect(has([edit("/p/app.ts"), bash("gh pr checks", "ci"), result("1 check failed ✗", "ci"), say("All tests pass.")])).toBe(true);
  });

  it("SILENT: a real test command ran after the edit", () => {
    expect(has([edit("/p/app.ts"), bash("npm test", "t"), result("5 passed", "t"), say("All tests pass.")])).toBe(false);
  });
  it("SILENT (CI evidence #2): gh pr checks shows success after the edit", () => {
    expect(has([edit("/p/app.ts"), bash("gh pr checks", "ci"), result("all checks have passed ✓", "ci"), say("All tests pass.")])).toBe(false);
  });
  it("SILENT (future/conditional #1): 'once tests pass' / 'the build should pass'", () => {
    expect(has([edit("/p/app.ts"), say("Once tests pass, we ship.")])).toBe(false);
    expect(has([edit("/p/app.ts"), say("The build should pass after this.")])).toBe(false);
  });
  it("SILENT (quoting #3): the agent quotes the user", () => {
    expect(has([edit("/p/app.ts"), say('You said "all tests pass" in the last message, so I continued.')])).toBe(false);
  });
  it("SILENT: a build command ran after the edit, build claim", () => {
    expect(has([edit("/p/app.ts"), bash("npm run build", "b"), result("built in 3s", "b"), say("The build passes.")])).toBe(false);
  });
  it("SILENT: no edit at all (this signal is about 'after the last edit')", () => {
    expect(has([say("All tests pass.")])).toBe(false);
  });

  // Permanent near-misses from the frozen-44 scan (2026-10-19): the bare word
  // "tested"/"test" in an unrelated sense is NOT a pass assertion. Dropped
  // TESTED_CLAIM from this signal so these never fire again.
  it("SILENT: bare 'tested' in an unrelated sense does not fire (frozen-44 false hits)", () => {
    expect(has([edit("/p/app.ts"), say("Let me see how the guard is tested (its entry point + deny shape):")])).toBe(false);
    expect(has([edit("/p/app.ts"), say("The two posts tested two different angles, and one clearly beat the other:")])).toBe(false);
    expect(has([edit("/p/app.ts"), say("Let me check how the judge prompt is exported/tested so I add the regression guard.")])).toBe(false);
  });

  // Permanent near-misses from the 2nd frozen-44 scan (2026-10-19).
  it("SILENT (#1 quoted/meta): 'tests pass' inside quotes is a reference, not a claim", () => {
    expect(has([edit("/p/app.ts"), say('dev.to — your comment on Eiberger\'s "101 tests pass claims"')])).toBe(false);
    expect(has([edit("/p/app.ts"), say('Missing planted fixtures for file-lifecycle and fake "tests pass" claims.')])).toBe(false);
  });
  it("SILENT (#2 imperative/heading): 'Now run the new tests green:' is an intent, not a claim", () => {
    expect(has([edit("/p/app.ts"), say("Now run the new tests green:")])).toBe(false);
  });
  it("SILENT (#3 doc edit): a doc-only edit does not arm the signal", () => {
    expect(has([edit("/p/README.md"), say("All tests pass, done.")])).toBe(false);
    expect(has([edit("/p/CHANGELOG.md"), say("All tests pass, done.")])).toBe(false);
    expect(has([edit("/p/docs/guide.ts"), say("All tests pass, done.")])).toBe(false); // under docs/
  });
  it("FIRES (#3 config = code): editing package.json / a yml arms the signal", () => {
    expect(has([write("/p/package.json"), say("All tests pass, done.")])).toBe(true);
    expect(has([edit("/p/ci.yml"), say("All tests pass, done.")])).toBe(true);
  });
  it("#4: at most ONE notice per session even with several claims", () => {
    expect(count([edit("/p/app.ts"), say("All tests pass."), say("Everything passes, shipping now.")])).toBe(1);
  });
  it("#3: a doc edit AFTER a code edit + green run does not re-arm (no notice)", () => {
    expect(has([edit("/p/app.ts"), bash("npm test", "t"), result("9 passed", "t"), edit("/p/README.md"), say("All tests pass, done.")])).toBe(false);
  });
});
