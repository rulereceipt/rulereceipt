import { describe, it, expect } from "vitest";
import { classifyRules } from "../src/checks/classify.js";
import { runCodeContentChecks } from "../src/checks/codeContent.js";
import { parseClaudeMdText } from "../src/parsers/claudeMdParser.js";
import type { TranscriptEvent } from "../src/types.js";
import type { CodeContentClassification } from "../src/checks/classify.js";

/**
 * A file/directory/route token is a PATH reference, not a code construct to
 * grep inside file content. Searching content for "dist/" or "README.md" or
 * "./types" matches every import, changelog line and package.json that merely
 * MENTIONS the path, producing "found X written into a file" — a false
 * accusation. Found in the false-accusation corpus run 2026-09-29: ~30
 * distinct FAIL texts were exactly this class. Import specifiers
 * (`lucide-react`, `@scope/pkg`) are NOT file tokens and stay checkable.
 */

const classifyOne = (text: string) => classifyRules(parseClaudeMdText(text, "project"))[0];

const wrote = (content: string): TranscriptEvent[] => [
  { role: "assistant", kind: "tool_use", toolName: "Write", input: { file_path: "a.ts", content }, timestamp: "t" },
];
// Force a codeContent run for a given pattern (proves the matcher too).
const asCodeContent = (pattern: string) =>
  [{ kind: "codeContent", rule: { id: "1", title: "t", text: `Never write \`${pattern}\`.`, source: "project" }, patterns: [pattern], polarity: "forbid" }] as unknown as CodeContentClassification[];

describe("file/dir/route tokens are not routed to codeContent content-search", () => {
  // These are the ACTUAL corpus rules (2026-09-29 run) that produced
  // "found <path> written into a file" false accusations on mere mentions.
  const fileTokenRules: string[] = [
    "## 1. dist\nBuild artifacts go in `dist/`. Never check files into `dist/` manually — CI rebuilds them on push, and `dist/` is gitignored.",
    "## 1. src\nDo not add new `BUILD` files under the `src/` tree without explicit instruction.",
    "## 1. gateway\nGateway commands stay local. `/status` and `/session` are never sent as normal prompt text to a bound harness.",
  ];
  for (const rule of fileTokenRules) {
    it(`does not route a file/dir/route token to codeContent: ${rule.split("\n")[0]}`, () => {
      const c = classifyOne(rule);
      expect(c.kind).not.toBe("codeContent");
    });
  }
});

describe("real import/value tokens stay checkable in codeContent", () => {
  it("a forbidden npm import is still codeContent and FAILs when written", () => {
    const c = classifyOne("Never import `lucide-react`.");
    expect(c.kind).toBe("codeContent");
    expect(runCodeContentChecks(asCodeContent("lucide-react"), wrote('import { Icon } from "lucide-react";'))[0].status).toBe("FAIL");
  });

  it("a scoped package subpath is still codeContent", () => {
    const c = classifyOne("Never import `@internal/secrets`.");
    expect(c.kind).toBe("codeContent");
  });
});
