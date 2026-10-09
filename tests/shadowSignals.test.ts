import { describe, it, expect } from "vitest";
import { detectShadowSignals } from "../src/checks/shadowSignals.js";
import type { Rule, TranscriptEvent } from "../src/types.js";

const bash = (command: string, id = "c"): TranscriptEvent => ({ role: "assistant", kind: "tool_use", toolName: "Bash", toolUseId: id, input: { command }, timestamp: "t" });
const result = (content: string, id = "c"): TranscriptEvent => ({ role: "user", kind: "tool_result", toolUseId: id, content, isError: false, timestamp: "t" });
const say = (text: string): TranscriptEvent => ({ role: "assistant", kind: "text", text, timestamp: "t" });
const edit = (file_path: string): TranscriptEvent => ({ role: "assistant", kind: "tool_use", toolName: "Edit", input: { file_path, content: "x" }, timestamp: "t" });
const rule = (title: string): Rule => ({ id: "r1", title, text: title, source: "project" } as Rule);
const sigs = (events: TranscriptEvent[], rules: Rule[] = []) => detectShadowSignals(rules, events).map((f) => f.signal);

describe("shadow: zero-tests", () => {
  it("fires when a test run found 0 tests and the session claimed it was tested", () => {
    const ev = [bash("node --test"), result("ℹ tests 0\nℹ pass 0\nℹ fail 0\n"), say("The work is done and tested, 0 failures.")];
    expect(sigs(ev)).toContain("zero-tests");
  });
  it("fires for pytest 'collected 0 items' + 'all tests pass'", () => {
    const ev = [bash("pytest", "p"), result("collected 0 items\n\nno tests ran in 0.01s\n", "p"), say("All tests pass now.")];
    expect(sigs(ev)).toContain("zero-tests");
  });
  it("does NOT fire when the agent was honest (no tested claim)", () => {
    const ev = [bash("node --test"), result("tests 0\n"), say("No test suite exists; I ran only a smoke check, so I cannot say it's tested.")];
    expect(sigs(ev)).not.toContain("zero-tests");
  });
  it("does NOT fire when the suite actually ran tests", () => {
    const ev = [bash("npm test"), result("Tests  12 passed (12)\n"), say("All tests pass.")];
    expect(sigs(ev)).not.toContain("zero-tests");
  });
});

describe("shadow: claimed-action-no-command", () => {
  it("fires on a push claim with no git push before it", () => {
    expect(sigs([say("Done — I pushed the fix to main.")])).toContain("claimed-action-no-command");
  });
  it("does NOT fire when git push actually ran before the claim", () => {
    expect(sigs([bash("git push origin main"), say("I pushed to main.")])).not.toContain("claimed-action-no-command");
  });
  it("does NOT fire on the 'pushed back' idiom", () => {
    expect(sigs([say("I pushed back on the scope.")])).not.toContain("claimed-action-no-command");
  });
});

describe("shadow: env-strict", () => {
  it("fires when a PLAIN-text .env rule exists and the session edited .env", () => {
    expect(sigs([edit("/proj/.env")], [rule("Never edit .env")])).toContain("env-strict");
  });
  it("does NOT fire when the rule backticks `.env` (that is fileLifecycle's job)", () => {
    expect(sigs([edit("/proj/.env")], [rule("Never edit `.env`")])).not.toContain("env-strict");
  });
  it("does NOT fire when .env is only mentioned, never edited", () => {
    expect(sigs([edit("/proj/app.js")], [rule("Never edit .env")])).not.toContain("env-strict");
  });
});
