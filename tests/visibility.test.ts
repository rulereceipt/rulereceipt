import { describe, it, expect } from "vitest";
import { classifyVisibility, applyVisibility } from "../src/visibility.js";
import type { CheckResult } from "../src/types.js";

const EV = 'the session ran "git push origin main"';
const push = JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "git push origin main" } }] } });
const inject = JSON.stringify({ type: "user", message: { role: "user", content: "<system-reminder>\nContents of /p/CLAUDE.md (project instructions, checked into the codebase):\nNever push to main.\n</system-reminder>" } });
const otherReminder = JSON.stringify({ type: "user", message: { role: "user", content: "<system-reminder>a background note, not a rules file</system-reminder>" } });
const compaction = JSON.stringify({ type: "user", isCompactSummary: true, message: { role: "user", content: "[compacted]" } });
const user = (t: string) => JSON.stringify({ type: "user", message: { role: "user", content: t } });
const t = (...lines: string[]) => lines.join("\n") + "\n";
const fail = (): CheckResult => ({ ruleId: "1", ruleTitle: "Branch", ruleSource: "project", status: "FAIL", evidence: EV });

describe("classifyVisibility — never guess; only downgrade when positively not visible", () => {
  it("loaded and broken → null (a real break)", () => {
    expect(classifyVisibility(t(inject, user("go"), push), EV)).toBeNull();
  });
  it("machinery present but no rules file before the break → not-in-context", () => {
    expect(classifyVisibility(t(otherReminder, user("go"), push), EV)).toMatchObject({ reason: "not-in-context" });
  });
  it("rules present then a compaction, not re-injected → stale-after-compaction", () => {
    expect(classifyVisibility(t(inject, compaction, push), EV)).toMatchObject({ reason: "stale-after-compaction" });
  });
  it("thin log with no context machinery → null (can't tell, stays Broken)", () => {
    expect(classifyVisibility(t(user("go"), push), EV)).toBeNull();
  });
  it("break not locatable → null", () => {
    expect(classifyVisibility(t(inject, push), "")).toBeNull();
  });
});

describe("applyVisibility — downgrades only the not-visible FAILs", () => {
  it("marks a not-visible FAIL, leaves a visible FAIL alone", () => {
    const notVisible = applyVisibility([fail()], t(otherReminder, push))[0];
    expect(notVisible.notVisible?.reason).toBe("not-in-context");
    const visible = applyVisibility([fail()], t(inject, push))[0];
    expect(visible.notVisible).toBeUndefined();
  });
  it("no transcript → unchanged; non-FAIL → unchanged", () => {
    expect(applyVisibility([fail()], undefined)[0].notVisible).toBeUndefined();
    const pass: CheckResult = { ruleId: "2", ruleTitle: "x", ruleSource: "project", status: "PASS", evidence: "" };
    expect(applyVisibility([pass], t(otherReminder, push))[0].notVisible).toBeUndefined();
  });
});
