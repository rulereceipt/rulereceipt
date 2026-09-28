import { describe, it, expect } from "vitest";
import { checkSessionInBrowser } from "../src/browser/evaluateBrowser.js";
import type { CheckResult } from "../src/types.js";

/**
 * Adversarial / look-alike regression suite.
 *
 * The one thing this tool must never do is accuse wrongly. A command that only
 * MENTIONS a forbidden action (in a quote, a comment, a heredoc that writes it,
 * or a read that merely names it) must never be read as the action running.
 * A disguised real action (config flags between `git` and the verb) must still
 * be caught. Each fixed false positive becomes a permanent case here.
 */

function statusFor(rules: string, command: string, titleRe: RegExp, tool = "Bash", input?: Record<string, unknown>): CheckResult["status"] | "none" {
  const session =
    JSON.stringify({ type: "assistant", timestamp: "t", message: { role: "assistant", content: [{ type: "tool_use", id: "a", name: tool, input: input ?? { command } }] } });
  const r = checkSessionInBrowser(rules, session).results.find((x) => titleRe.test(x.ruleTitle));
  return r?.status ?? "none";
}

const BRANCH = "## 1. Never push to main\nNever push directly to the `main` branch.\n";
const ENV = "## 1. Never edit `.env`\nNever edit `.env`.\n";
const LOG = "## 1. No debug logging\nNever leave a `console.log(` call in committed code.\n";

describe("mentions and look-alikes are never Broken", () => {
  it("git push in a quote is not a push (branch rule)", () => {
    expect(statusFor(BRANCH, 'echo "git push origin main"', /never push/i)).not.toBe("FAIL");
  });
  it("git push in a comment is not a push (branch rule)", () => {
    expect(statusFor(BRANCH, "cat x.txt # remember: git push origin main", /never push/i)).not.toBe("FAIL");
  });
  it("`git log main` is not a push to main", () => {
    expect(statusFor(BRANCH, "git log main", /never push/i)).not.toBe("FAIL");
  });
  it("a real push to main IS caught", () => {
    expect(statusFor(BRANCH, "git push origin main", /never push/i)).toBe("FAIL");
  });
  it("a disguised push with config flags is still caught", () => {
    expect(statusFor(BRANCH, "git -c protocol.version=2 push origin main", /never push/i)).toBe("FAIL");
  });

  it("mentioning console.log in a shell echo is not writing it into a file", () => {
    expect(statusFor(LOG, 'echo "console.log(1)"', /debug logging/i)).not.toBe("FAIL");
  });
  it("console.log actually written into a file IS caught", () => {
    expect(statusFor(LOG, "", /debug logging/i, "Write", { file_path: "a.ts", content: "console.log(1)" })).toBe("FAIL");
  });

  it(".env.example is not .env", () => {
    expect(statusFor(ENV, "", /never edit/i, "Edit", { file_path: ".env.example", old_string: "a", new_string: "b" })).not.toBe("FAIL");
  });
  it("editing .env itself IS caught", () => {
    expect(statusFor(ENV, "", /never edit/i, "Edit", { file_path: ".env", old_string: "a", new_string: "b" })).toBe("FAIL");
  });
});
