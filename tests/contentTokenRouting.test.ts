import { describe, it, expect } from "vitest";
import { classifyRule } from "../src/checks/classify.js";
import { runCodeContentChecks } from "../src/checks/codeContent.js";
import type { CodeContentClassification } from "../src/checks/classify.js";
import type { TranscriptEvent } from "../src/types.js";

/**
 * Literal checks on ADDED code (2026-09-28). A forbid rule naming a
 * distinctive token — an import like `lucide-react`, a value like `#0af` —
 * used to route to the generic deterministic check and report UNCLEAR (a text
 * match can't tell action from mention). But when that token appears in
 * content the agent WROTE via Write/Edit, that IS the action, so codeContent
 * can FAIL on it confidently. Scoped to distinctive punctuation-bearing tokens
 * so plain English words (which appear in prose) and shell commands are never
 * swept in, and protected-file rules still go to fileLifecycle.
 */
const rule = (text: string, title = "R") => ({ id: "1", title, text, source: "project" as const });
const wrote = (content: string, file = "src/app.tsx"): TranscriptEvent[] => [
  { role: "assistant", kind: "tool_use", toolName: "Write", input: { file_path: file, content }, timestamp: "t" },
];
const ranBash = (command: string): TranscriptEvent[] => [
  { role: "assistant", kind: "tool_use", toolName: "Bash", input: { command }, timestamp: "t" },
];

describe("distinctive forbidden tokens in written content", () => {
  it("routes a forbid rule naming a punctuation token (an import) to codeContent", () => {
    expect(classifyRule(rule("Never import `lucide-react`.")).kind).toBe("codeContent");
  });

  it("FAILs when the banned import is in written content", () => {
    const cls = classifyRule(rule("Never import `lucide-react`.")) as CodeContentClassification;
    expect(cls.kind).toBe("codeContent");
    const [r] = runCodeContentChecks([cls], wrote("import { Home } from 'lucide-react'\n"));
    expect(r.status).toBe("FAIL");
    expect(r.evidence).toMatch(/lucide-react/);
  });

  it("does NOT fail when the token only appears in a Bash command (mention, not written content)", () => {
    const cls = classifyRule(rule("Never import `lucide-react`.")) as CodeContentClassification;
    const [r] = runCodeContentChecks([cls], ranBash("grep -rn lucide-react src/"));
    expect(r.status).not.toBe("FAIL");
  });

  it("does NOT route a plain-word literal to codeContent (it would match prose)", () => {
    expect(classifyRule(rule("Never leave a `TODO` in the code.")).kind).not.toBe("codeContent");
  });

  it("does NOT route a shell-command literal to codeContent", () => {
    expect(classifyRule(rule("Never run `git push --force`.")).kind).not.toBe("codeContent");
  });

  it("still routes a protected-file rule to fileLifecycle, not codeContent", () => {
    expect(classifyRule(rule("Never modify `.env`.")).kind).toBe("fileLifecycle");
  });

  it("still routes a call literal to codeContent (unchanged behaviour)", () => {
    expect(classifyRule(rule("Never call `analytics.track(` directly.")).kind).toBe("codeContent");
  });
});
