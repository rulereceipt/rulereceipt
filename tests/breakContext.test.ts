import { describe, it, expect } from "vitest";
import { breakContext, renderBreakContext } from "../src/breakContext.js";

/**
 * A4 context is read from the raw transcript. These fixtures pin the three facts
 * and, crucially, the honesty rule: when the rules file never appears before the
 * break, the output must say "NOT in context", never that the agent ignored it.
 */

const inject = (path = "/proj/CLAUDE.md") =>
  JSON.stringify({ type: "user", message: { role: "user", content: `<system-reminder>\nContents of ${path} (project instructions, checked into the codebase):\n# Rules\nNever push to main.\n</system-reminder>` } });
const userMsg = (text: string) => JSON.stringify({ type: "user", message: { role: "user", content: text } });
const compaction = () => JSON.stringify({ type: "user", isCompactSummary: true, message: { role: "user", content: "[conversation compacted]" } });
const push = () => JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "git push origin main" } }] } });
const EV = 'the session ran "git push origin main"';

describe("breakContext — the three facts, read from the raw transcript", () => {
  it("rules present, no compaction: in-context, captures the preceding user message", () => {
    const t = [inject(), userMsg("fix the login bug"), push()].join("\n");
    const c = breakContext(t, EV);
    expect(c.located).toBe(true);
    expect(c.rulesInContext).toBe(true);
    expect(c.compactionBefore).toBe(false);
    expect(c.rulesStaleAfterCompaction).toBe(false);
    expect(c.precedingUser).toBe("fix the login bug");
  });

  it("thin shell-heavy session (no context machinery): can't tell, not a guess", () => {
    const t = [userMsg("deploy it"), push()].join("\n");
    const c = breakContext(t, EV);
    expect(c.located).toBe(true);
    expect(c.rulesInContext).toBe(false);
    // No system-reminder / attachment / compaction anywhere -> can't conclude absent.
    expect(c.contextObserved).toBe(false);
    const out = renderBreakContext(c).join("\n");
    expect(out.toLowerCase()).toContain("couldn't tell");
    expect(out.toLowerCase()).not.toContain("ignored");
  });

  it("session WITH context machinery but no rules file: contextObserved, not in context", () => {
    // a system-reminder for something else, but never the rules file
    const other = JSON.stringify({ type: "user", message: { role: "user", content: "<system-reminder>Background note, not a rules file.</system-reminder>" } });
    const t = [other, userMsg("deploy it"), push()].join("\n");
    const c = breakContext(t, EV);
    expect(c.rulesInContext).toBe(false);
    expect(c.contextObserved).toBe(true);
  });

  it("ef53e676 pattern: rules present BEFORE a compaction, gone after → stale", () => {
    const t = [inject(), userMsg("start work"), compaction(), userMsg("continue"), push()].join("\n");
    const c = breakContext(t, EV);
    expect(c.rulesInContext).toBe(true);
    expect(c.compactionBefore).toBe(true);
    expect(c.rulesStaleAfterCompaction).toBe(true);
    expect(c.contextObserved).toBe(true);
    expect(c.precedingUser).toBe("continue");
  });

  it("rules re-injected AFTER the compaction: not stale", () => {
    const t = [inject(), compaction(), inject(), push()].join("\n");
    const c = breakContext(t, EV);
    expect(c.compactionBefore).toBe(true);
    expect(c.rulesStaleAfterCompaction).toBe(false);
    expect(renderBreakContext(c).join("\n")).toContain("in context before this");
  });

  it("evidence with no quotable fragment: not located, renders nothing", () => {
    const t = [inject(), push()].join("\n");
    const c = breakContext(t, "");
    expect(c.located).toBe(false);
    expect(renderBreakContext(c)).toEqual([]);
  });
});
