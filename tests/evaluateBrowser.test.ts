import { describe, it, expect } from "vitest";
import { checkSessionInBrowser, evaluateBrowserSession } from "../src/browser/evaluateBrowser.js";

const RULES = [
  "## 1. Never push without asking",
  "Never push without explicit user instruction.",
  "",
  "## 2. Never edit `.env`",
  "Never edit `.env`.",
  "",
].join("\n");

const session = (mode: string) =>
  [
    { type: "user", timestamp: "t", permissionMode: mode, message: { role: "user", content: "fix the page" } },
    { type: "assistant", timestamp: "t", message: { role: "assistant", content: [{ type: "tool_use", id: "a", name: "Bash", input: { command: "git push origin main" } }] } },
    { type: "user", timestamp: "t", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "ok" }] } },
  ]
    .map((o) => JSON.stringify(o))
    .join("\n");

describe("browser session check (client-side, no Node)", () => {
  it("flags an unapproved push as FAIL", () => {
    const s = checkSessionInBrowser(RULES, session("bypassPermissions"));
    expect(s.fail).toBeGreaterThanOrEqual(1);
    const push = s.results.find((r) => /never push/i.test(r.ruleTitle));
    expect(push?.status).toBe("FAIL");
    expect(s.events).toBeGreaterThan(0);
  });

  it("returns a verdict per rule and never crashes on empty input", () => {
    const s = checkSessionInBrowser(RULES, "");
    expect(s.results.length).toBeGreaterThanOrEqual(2);
    expect(s.fail).toBe(0);
  });

  it("skips malformed lines instead of failing the whole check", () => {
    const s = checkSessionInBrowser(RULES, `not json\n{bad\n${session("bypassPermissions")}`);
    expect(s.fail).toBeGreaterThanOrEqual(1);
  });

  it("in default mode a push is UNCLEAR, not FAIL (a prompt may have been approved)", () => {
    const push = evaluateBrowserSession(RULES, session("default")).find((r) => /never push/i.test(r.ruleTitle));
    expect(push?.status).not.toBe("FAIL");
  });
});
