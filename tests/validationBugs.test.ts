import { describe, it, expect } from "vitest";
import { checkSessionInBrowser } from "../src/browser/evaluateBrowser.js";
import { classifyRules } from "../src/checks/classify.js";
import { parseClaudeMdText } from "../src/parsers/claudeMdParser.js";

/**
 * The three false-accusation classes found by the unseen-data validation of
 * 0.1.74 (2026-09-29). Each was a real "Broken" a person looking at the same
 * evidence would not call a violation — the exact failure this product exists to
 * prevent. Each fix removes the false accusation while keeping the real one.
 */
const sess = (l: unknown[]) => l.map((x) => JSON.stringify(x)).join("\n");
const asst = (c: unknown[]) => ({ type: "assistant", timestamp: "t", message: { role: "assistant", content: c } });
const write = (f: string, c: string) => asst([{ type: "tool_use", id: "w", name: "Write", input: { file_path: f, content: c } }]);
const bash = (c: string, id = "b") => asst([{ type: "tool_use", id, name: "Bash", input: { command: c } }]);
const result = (id: string, t: string, err: boolean) => ({ type: "user", timestamp: "t", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: t, is_error: err }] } });
const text = (t: string) => asst([{ type: "text", text: t }]);
const kind = (r: string) => (classifyRules(parseClaudeMdText(r, "project"))[0] as { kind: string }).kind;
const verdict = (r: string, l: unknown[]) => checkSessionInBrowser(r, sess(l)).results[0]?.status;

describe("BUG 1 — a code token inside prose is a mention, not code", () => {
  const RULE = "## 1. x\nAvoid `try-catch` in hot paths.\n";
  it("`try-catch` inside an HTML/prose string is NOT Broken", () => {
    expect(verdict(RULE, [write("q.py", 'MAP=[("q","<p>use a try-catch block here</p>")]')])).not.toBe("FAIL");
  });
  it("a real call written into a file IS still Broken", () => {
    expect(verdict("## 1. x\nNever leave a `console.log(` call.\n", [write("a.ts", "console.log(1)")])).toBe("FAIL");
  });
  it("a real import specifier (bounded by quotes, not prose) IS still Broken", () => {
    expect(verdict("## 1. x\nNever import `lucide-react`.\n", [write("a.tsx", 'import { Icon } from "lucide-react";')])).toBe("FAIL");
  });
});

describe("BUG 2 — a deliberately-broken test VARIANT does not contradict a default-suite claim", () => {
  const RULE = "## 1. x\nNever report a thing as done without evidence.\n";
  it("`npm test` green, then `DISABLE_LOCKS=1 npm test` red, then 'all tests pass' is NOT Broken", () => {
    expect(verdict(RULE, [
      bash("npm test", "t1"), result("t1", "36 passing", false),
      bash("DISABLE_LOCKS=1 npm test", "t2"), result("t2", "Failed Tests 6", true),
      text("Backend: UP, all 36 tests pass"),
    ])).not.toBe("FAIL");
  });
  it("the DEFAULT suite failing, then 'all tests pass', IS still Broken", () => {
    expect(verdict(RULE, [bash("npm test", "t1"), result("t1", "Failed Tests 6", true), text("all tests pass now")])).toBe("FAIL");
  });
});

describe("BUG 3 — a file-scoped 'confirm before committing' note is not a blanket approval gate", () => {
  it("a note about one untracked file ('confirm before committing') is NOT an approval gate", () => {
    expect(kind("## 1. x\n`extension-report.py` is a variant of the reporter (currently untracked; confirm before committing).\n")).not.toBe("approvalGate");
  });
  it("a real 'never commit without asking me first' IS an approval gate", () => {
    expect(kind("## 1. x\nNever commit without asking me first.\n")).toBe("approvalGate");
  });
  it("a real 'ask me before pushing' IS an approval gate", () => {
    expect(kind("## 1. x\nAlways ask me before pushing.\n")).toBe("approvalGate");
  });
});
