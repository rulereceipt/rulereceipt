import { describe, it, expect } from "vitest";
import { runCodeContentChecks } from "../src/checks/codeContent.js";
import type { CodeContentClassification } from "../src/checks/classify.js";
import type { TranscriptEvent } from "../src/types.js";

/**
 * A banned call is the call, not any identifier that ends with it.
 *
 * Found 2026-09-15 by checking a remaining corpus FAIL instead of assuming it
 * was legitimate. A rule forbidding `fetch()` was reported against a file
 * whose text is `_metar_fetch()` - verbatim substring, entirely the wrong
 * function. The same shape makes `main()` match `domain()` and `run()` match
 * `rerun()`, and short generic call names are exactly what rules like this
 * tend to name.
 *
 * Matching was a bare String.includes. It now requires the character before
 * the pattern not to be part of an identifier.
 */
const cls = (pattern: string) =>
  [{ kind: "codeContent", rule: { id: "1", title: "No direct calls", text: `Never call \`${pattern}\`.`, source: "project" }, patterns: [pattern], polarity: "forbid" }] as unknown as CodeContentClassification[];

const wrote = (content: string): TranscriptEvent[] => [
  { role: "assistant", kind: "tool_use", toolName: "Write", input: { file_path: "a.py", content }, timestamp: "t" },
];

describe("content matching respects identifier boundaries", () => {
  it("does not match fetch() inside _metar_fetch()", () => {
    expect(runCodeContentChecks(cls("fetch()"), wrote('Reuses _metar_fetch()\'s already-fetched "dewp" field'))[0].status).not.toBe("FAIL");
  });

  it("does not match main() inside domain()", () => {
    expect(runCodeContentChecks(cls("main()"), wrote("url = domain() + path"))[0].status).not.toBe("FAIL");
  });

  it("does not match run() inside rerun()", () => {
    expect(runCodeContentChecks(cls("run()"), wrote("rerun() if failed"))[0].status).not.toBe("FAIL");
  });

  it("still matches a real call", () => {
    expect(runCodeContentChecks(cls("fetch()"), wrote("const r = await fetch()"))[0].status).toBe("FAIL");
  });

  it("still matches a real call at the start of a line", () => {
    expect(runCodeContentChecks(cls("main()"), wrote("main()\n"))[0].status).toBe("FAIL");
  });

  it("still matches a dotted call", () => {
    expect(runCodeContentChecks(cls("console.log("), wrote("  console.log('x')"))[0].status).toBe("FAIL");
  });
});
