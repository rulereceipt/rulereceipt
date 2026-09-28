import { describe, it, expect } from "vitest";
import { detectSelfEditedRuleFiles } from "../src/checks/selfEditedRules.js";
import type { TranscriptEvent } from "../src/types.js";

const write = (file_path: string): TranscriptEvent => ({ role: "assistant", kind: "tool_use", toolName: "Write", input: { file_path, content: "x" }, timestamp: "t" });
const edit = (file_path: string): TranscriptEvent => ({ role: "assistant", kind: "tool_use", toolName: "Edit", input: { file_path, old_string: "a", new_string: "b" }, timestamp: "t" });
const read = (file_path: string): TranscriptEvent => ({ role: "assistant", kind: "tool_use", toolName: "Read", input: { file_path }, timestamp: "t" });
const bash = (command: string): TranscriptEvent => ({ role: "assistant", kind: "tool_use", toolName: "Bash", input: { command }, timestamp: "t" });

describe("detectSelfEditedRuleFiles", () => {
  it("flags Write/Edit to rules and settings files", () => {
    expect(detectSelfEditedRuleFiles([write("/r/CLAUDE.md")])).toEqual(["/r/CLAUDE.md"]);
    expect(detectSelfEditedRuleFiles([edit("/r/AGENTS.md")])).toEqual(["/r/AGENTS.md"]);
    expect(detectSelfEditedRuleFiles([write("/r/.claude/settings.json")])).toEqual(["/r/.claude/settings.json"]);
    expect(detectSelfEditedRuleFiles([edit("/r/.claude/rules/db.md")])).toEqual(["/r/.claude/rules/db.md"]);
    expect(detectSelfEditedRuleFiles([write("/r/.rulereceipt/config.json")])).toEqual(["/r/.rulereceipt/config.json"]);
  });

  it("flags shell writes that TARGET a rules file", () => {
    expect(detectSelfEditedRuleFiles([bash("echo '- new rule' >> CLAUDE.md")])).toEqual(["CLAUDE.md"]);
    expect(detectSelfEditedRuleFiles([bash("sed -i 's/never/always/' AGENTS.md")])).toEqual(["AGENTS.md"]);
    expect(detectSelfEditedRuleFiles([bash("cp template.md CLAUDE.md")])).toEqual(["CLAUDE.md"]);
    expect(detectSelfEditedRuleFiles([bash("tee -a .claude/settings.json < x")])).toEqual([".claude/settings.json"]);
  });

  it("does NOT flag reads or unrelated writes (no false warning)", () => {
    expect(detectSelfEditedRuleFiles([read("/r/CLAUDE.md")])).toEqual([]);
    expect(detectSelfEditedRuleFiles([bash("cat CLAUDE.md")])).toEqual([]);
    expect(detectSelfEditedRuleFiles([bash("grep -n never CLAUDE.md")])).toEqual([]);
    expect(detectSelfEditedRuleFiles([bash("sed -n '1,5p' CLAUDE.md")])).toEqual([]);
    expect(detectSelfEditedRuleFiles([bash("cat CLAUDE.md > /dev/null")])).toEqual([]); // target is /dev/null, not the rule file
    expect(detectSelfEditedRuleFiles([bash("echo x > src/foo.ts")])).toEqual([]);
    expect(detectSelfEditedRuleFiles([write("/r/src/app.ts")])).toEqual([]);
  });

  it("dedupes across multiple edits", () => {
    expect(detectSelfEditedRuleFiles([write("/r/CLAUDE.md"), edit("/r/CLAUDE.md"), bash("echo x >> /r/CLAUDE.md")])).toEqual(["/r/CLAUDE.md"]);
  });
});
