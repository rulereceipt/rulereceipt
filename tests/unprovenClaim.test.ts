import { describe, it, expect } from "vitest";
import { detectShadowSignals } from "../src/checks/shadowSignals.js";
import type { TranscriptEvent } from "../src/types.js";

const bash = (command: string, id = "c"): TranscriptEvent => ({ role: "assistant", kind: "tool_use", toolName: "Bash", toolUseId: id, input: { command }, timestamp: "t" });
const result = (content: string, id = "c"): TranscriptEvent => ({ role: "user", kind: "tool_result", toolUseId: id, content, isError: false, timestamp: "t" });
const say = (text: string): TranscriptEvent => ({ role: "assistant", kind: "text", text, timestamp: "t" });
const edit = (file_path: string): TranscriptEvent => ({ role: "assistant", kind: "tool_use", toolName: "Edit", input: { file_path, content: "x" }, timestamp: "t" });
const has = (events: TranscriptEvent[]) => detectShadowSignals([], events).map((f) => f.signal).includes("unproven-claim");

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
});
