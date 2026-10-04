import { describe, it, expect } from "vitest";
import { classifyRule } from "../src/checks/classify.js";
import { runCodeContentChecks } from "../src/checks/codeContent.js";
import type { CodeContentClassification } from "../src/checks/classify.js";
import type { TranscriptEvent } from "../src/types.js";

/**
 * False accusation found by fa-corpus-v2 (2026-10-04): codeContent fired
 * "found console.log( written into a file" on a token that appears only in a
 * COMMENT ("// never use console.log( here"). A mention in a comment is not a
 * call. The checker must ignore matches inside comments (and, for a call
 * pattern, inside string literals) — while still matching a real call, and
 * still matching an import specifier that legitimately lives in a quoted string.
 */
const codeRule = (text: string): CodeContentClassification => classifyRule({ id: "1", title: "r", text, source: "project" }) as CodeContentClassification;
const write = (content: string): TranscriptEvent => ({ role: "assistant", kind: "tool_use", toolName: "Write", input: { file_path: "src/x.ts", content }, timestamp: "t" });
const statusOf = (ruleText: string, content: string) => {
  const cls = codeRule(ruleText);
  if (cls.kind !== "codeContent") return `NOT-codeContent(${cls.kind})`;
  return runCodeContentChecks([cls], [write(content)])[0].status;
};

describe("codeContent ignores matches inside comments/strings", () => {
  const RULE = "Never leave a `console.log(` call in committed code.";

  it("does NOT fire on a // line-comment mention (the v2 false accusation)", () => {
    expect(statusOf(RULE, "// NOTE: never use console.log( here\nexport const x = 1;\n")).not.toBe("FAIL");
  });
  it("does NOT fire on a /* block comment */ mention", () => {
    expect(statusOf(RULE, "/* reminder: console.log( is banned */\nconst y = 2;\n")).not.toBe("FAIL");
  });
  it("does NOT fire on a # line-comment mention", () => {
    expect(statusOf(RULE, "# avoid console.log( in this script\nprint(1)\n")).not.toBe("FAIL");
  });
  it("does NOT fire when the token is only inside a string literal", () => {
    expect(statusOf(RULE, 'const help = "do not call console.log( yourself";\n')).not.toBe("FAIL");
  });

  // The real check must survive: a genuine call still FAILs.
  it("STILL fires on a real console.log( call outside any comment/string", () => {
    expect(statusOf(RULE, "export function f() {\n  console.log(x);\n}\n")).toBe("FAIL");
  });
  it("STILL fires on a real call even when a comment also mentions it", () => {
    expect(statusOf(RULE, "// no console.log( please\nconsole.log(value);\n")).toBe("FAIL");
  });

  // Imports live in quoted strings — must NOT be stripped away for a token rule.
  it("STILL matches an import specifier inside quotes (strings kept for non-call tokens)", () => {
    const cls = codeRule("Never import `lucide-react`.");
    if (cls.kind !== "codeContent") throw new Error("expected codeContent, got " + cls.kind);
    const r = runCodeContentChecks([cls], [write('import { Icon } from "lucide-react";\n')])[0];
    expect(r.status).toBe("FAIL");
  });
});
