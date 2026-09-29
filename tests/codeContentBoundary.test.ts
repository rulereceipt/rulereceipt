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

  // #4 (2026-09-26): a rule naming a bare METHOD missed the member-access
  // call, because `.` was treated as identifier-continuation. `analytics.track(`
  // IS a call to `track(`; the `.` is a separator.
  it("matches a bare method-name rule against a member-access call", () => {
    expect(runCodeContentChecks(cls("track("), wrote("  analytics.track(userId)"))[0].status).toBe("FAIL");
  });

  it("matches a bare method against a deeply-dotted call", () => {
    expect(runCodeContentChecks(cls("log("), wrote("  this.logger.log('x')"))[0].status).toBe("FAIL");
  });

  it("still does not match a method name fused into a longer identifier", () => {
    expect(runCodeContentChecks(cls("track("), wrote("  backtrack(state)"))[0].status).not.toBe("FAIL");
  });

  // A punct-leading, non-call token (a dotfile/extension like `.env`) embedded
  // after an identifier is a property access or a longer token, not the token
  // itself. `.env` inside `process.env` is not the .env file. Found in the
  // false-accusation corpus run 2026-09-29: a rule "never commit secrets to
  // .env" FAILed every file using process.env.
  it("does not match .env inside process.env", () => {
    expect(runCodeContentChecks(cls(".env"), wrote("const k = process.env.API_KEY"))[0].status).not.toBe("FAIL");
  });

  it("does not match .env inside import.meta.env", () => {
    expect(runCodeContentChecks(cls(".env"), wrote("const base = import.meta.env.BASE_URL"))[0].status).not.toBe("FAIL");
  });

  it("still matches a real quoted .env file reference", () => {
    expect(runCodeContentChecks(cls(".env"), wrote('fs.writeFileSync(".env", secret)'))[0].status).toBe("FAIL");
  });

  it("still matches a .env path reference", () => {
    expect(runCodeContentChecks(cls(".env"), wrote("const p = './.env'"))[0].status).toBe("FAIL");
  });
});
