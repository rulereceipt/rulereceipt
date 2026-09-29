import { describe, it, expect } from "vitest";
import { checkSessionInBrowser } from "../src/browser/evaluateBrowser.js";

/**
 * "You asked for it", generalised past push/commit/pr to every structured rule.
 * When the agent does a forbidden thing the USER explicitly told it to do in
 * this session, that is the user overriding their own rule — not the agent
 * breaking it — so the FAIL becomes "can't tell" with the user's quote. It can
 * only ever downgrade a FAIL, never create one, and it must NOT fire on a
 * negation ("don't edit .env") or a question ("should we push to main?"),
 * because that would let a real violation off — a detection loss.
 */
function sessionOf(lines: unknown[]): string {
  return lines.map((l) => JSON.stringify(l)).join("\n");
}
const asst = (content: unknown[]) => ({ type: "assistant", timestamp: "t", message: { role: "assistant", content } });
const user = (text: string) => ({ type: "user", timestamp: "t", message: { role: "user", content: text } });
const bash = (command: string) => asst([{ type: "tool_use", id: "b", name: "Bash", input: { command } }]);
const edit = (file_path: string) => asst([{ type: "tool_use", id: "e", name: "Edit", input: { file_path, old_string: "a", new_string: "b" } }]);
const write = (file_path: string, content: string) => asst([{ type: "tool_use", id: "w", name: "Write", input: { file_path, content } }]);

const BRANCH = "## 1. Never push to `main`\nNever push directly to the `main` branch.\n";
const ENV = "## 1. Never edit `.env`\nNever edit the `.env` file.\n";
const LOG = "## 1. No debug logging\nNever leave a `console.log(` call in committed code.\n";

const verdict = (rules: string, lines: unknown[], titleRe: RegExp) =>
  checkSessionInBrowser(rules, sessionOf(lines)).results.find((r) => titleRe.test(r.ruleTitle))?.status ?? "none";

describe("you-asked-for-it downgrades a structured FAIL to can't-tell", () => {
  it("push to main the user explicitly asked for is no longer FAIL", () => {
    expect(verdict(BRANCH, [user("push it to main please"), bash("git push origin main")], /never push/i)).toBe("UNCLEAR");
  });
  it("editing .env the user asked for is no longer FAIL", () => {
    expect(verdict(ENV, [user("go ahead and edit the .env file directly"), edit(".env")], /never edit/i)).toBe("UNCLEAR");
  });
  it("a console.log the user asked for is no longer FAIL", () => {
    expect(verdict(LOG, [user("add a console.log( to debug this"), write("a.ts", "console.log(1)")], /debug logging/i)).toBe("UNCLEAR");
  });
});

describe("it does NOT downgrade a real violation (detection preserved)", () => {
  it("push to main with no user instruction stays FAIL", () => {
    expect(verdict(BRANCH, [user("fix the login page"), bash("git push origin main")], /never push/i)).toBe("FAIL");
  });
  it("a NEGATED instruction ('don't push to main') stays FAIL", () => {
    expect(verdict(BRANCH, [user("whatever you do, don't push to main"), bash("git push origin main")], /never push/i)).toBe("FAIL");
  });
  it("a QUESTION ('should we push to main?') stays FAIL", () => {
    expect(verdict(BRANCH, [user("should we push to main here?"), bash("git push origin main")], /never push/i)).toBe("FAIL");
  });
  it("asking for .env.example does not clear a .env violation", () => {
    expect(verdict(ENV, [user("please edit .env.example"), edit(".env")], /never edit/i)).toBe("FAIL");
  });
});
