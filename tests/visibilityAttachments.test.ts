import { describe, it, expect } from "vitest";
import { breakContext } from "../src/breakContext.js";

/**
 * Attachment-grounded visibility (2026-10-05). Modern Claude Code injects the
 * rules file as an `instructions` attachment (files[].path) or a `nested_memory`
 * attachment — not the older "Contents of CLAUDE.md" header. breakContext must
 * recognise those as the rule being IN CONTEXT; otherwise a real break is wrongly
 * downgraded to "rule not visible" (a MISSED accusation). It must NOT count an
 * instructions attachment that lists only non-rules files.
 */
const instr = (path: string) =>
  JSON.stringify({ type: "user", message: { role: "user", content: "go" }, toolUseResult: { type: "instructions", files: [{ path }] } });
const nestedMem = () =>
  JSON.stringify({ type: "user", message: { role: "user", content: "go" }, toolUseResult: { type: "nested_memory", path: "/U/p/CLAUDE.md" } });
const breakLine = JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "git push origin main" } }] } });
const EV = 'pushed to "main" without asking: git push origin main';

describe("visibility grounded in instructions/nested_memory attachments", () => {
  it("counts an instructions attachment naming CLAUDE.md as rules-in-context", () => {
    const ctx = breakContext(instr("/Users/x/proj/CLAUDE.md") + "\n" + breakLine, EV);
    expect(ctx.located).toBe(true);
    expect(ctx.rulesInContext).toBe(true);
  });

  it("counts an AGENTS.md instructions attachment too", () => {
    const ctx = breakContext(instr("/Users/x/proj/AGENTS.md") + "\n" + breakLine, EV);
    expect(ctx.rulesInContext).toBe(true);
  });

  it("counts a nested_memory attachment as rules-in-context", () => {
    const ctx = breakContext(nestedMem() + "\n" + breakLine, EV);
    expect(ctx.rulesInContext).toBe(true);
  });

  it("does NOT count an instructions attachment that names only a non-rules file", () => {
    const ctx = breakContext(instr("/Users/x/proj/docs/notes.md") + "\n" + breakLine, EV);
    expect(ctx.rulesInContext).toBe(false);
  });
});
