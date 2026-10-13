import { describe, it, expect } from "vitest";
import {
  DOC_FILE,
  editedContentFromEvent,
  isProseSandwich,
  stripCode,
  containsCall,
} from "../src/checks/codeContent.js";
import type { TranscriptEvent } from "../src/types.js";

/**
 * Direct unit coverage of codeContent's internal helpers. These pin the exact
 * boundaries of the hand-written string/comment stripper and the call matcher,
 * which the end-to-end checker tests only exercised indirectly (mutation testing
 * showed most of stripCode/containsCall surviving). Behaviour-neutral exports.
 */

const write = (file_path: string, content: string): TranscriptEvent => ({ role: "assistant", kind: "tool_use", toolName: "Write", input: { file_path, content }, timestamp: "t" });
const edit = (file_path: string, new_string: string): TranscriptEvent => ({ role: "assistant", kind: "tool_use", toolName: "Edit", input: { file_path, new_string }, timestamp: "t" });
const notebook = (notebook_path: string, new_source: string): TranscriptEvent => ({ role: "assistant", kind: "tool_use", toolName: "NotebookEdit", input: { notebook_path, new_source }, timestamp: "t" });

describe("DOC_FILE", () => {
  it("matches doc extensions at the end of the path", () => {
    for (const p of ["notes.md", "a.markdown", "b.mdx", "c.txt", "d.text", "e.rst", "f.adoc", "g.asciidoc", "h.org"]) {
      expect(DOC_FILE.test(p), p).toBe(true);
    }
  });
  it("is anchored at the end: a code file whose name merely contains a doc ext is NOT a doc", () => {
    expect(DOC_FILE.test("foo.markdown.ts")).toBe(false);
    expect(DOC_FILE.test("readme.md.js")).toBe(false);
    expect(DOC_FILE.test("app.ts")).toBe(false);
  });
  it("is case-insensitive", () => {
    expect(DOC_FILE.test("README.MD")).toBe(true);
  });
});

describe("editedContentFromEvent", () => {
  it("returns Write content for a non-doc path", () => {
    expect(editedContentFromEvent(write("src/a.ts", "print(1)"))).toBe("print(1)");
  });
  it("returns Edit new_string for a non-doc path", () => {
    expect(editedContentFromEvent(edit("src/a.ts", "log(x)"))).toBe("log(x)");
  });
  it("returns NotebookEdit new_source (keyed off notebook_path)", () => {
    expect(editedContentFromEvent(notebook("nb.ipynb", "track(e)"))).toBe("track(e)");
  });
  it("returns null for a doc path even with code-shaped content", () => {
    expect(editedContentFromEvent(write("docs/readme.md", "print(1)"))).toBeNull();
    expect(editedContentFromEvent(notebook("notes.md", "print(1)"))).toBeNull();
  });
  it("returns null for a non-tool_use event", () => {
    expect(editedContentFromEvent({ role: "assistant", kind: "text", text: "print(1)", timestamp: "t" })).toBeNull();
  });
  it("returns null when the matching field is absent or wrong type", () => {
    expect(editedContentFromEvent({ role: "assistant", kind: "tool_use", toolName: "Write", input: { file_path: "a.ts" }, timestamp: "t" })).toBeNull();
    expect(editedContentFromEvent({ role: "assistant", kind: "tool_use", toolName: "Write", input: { file_path: "a.ts", content: 5 }, timestamp: "t" })).toBeNull();
    expect(editedContentFromEvent({ role: "assistant", kind: "tool_use", toolName: "Read", input: { file_path: "a.ts", content: "print(1)" }, timestamp: "t" })).toBeNull();
  });
});

describe("stripCode: comments", () => {
  it("removes a // line comment entirely (no space), keeps the rest", () => {
    expect(stripCode("a // comment\nb", false)).toBe("a \nb");
  });
  it("replaces a /* block comment */ with a single space", () => {
    expect(stripCode("a/*c*/b", false)).toBe("a b");
  });
  it("removes a # comment at line start", () => {
    expect(stripCode("# c\nb", false)).toBe("\nb");
  });
  it("removes a # comment after whitespace", () => {
    expect(stripCode("x # c\ny", false)).toBe("x \ny");
  });
  it("keeps a # that is NOT at a line start / after space (TS private field survives)", () => {
    expect(stripCode("this.#count", false)).toBe("this.#count");
  });
});

describe("stripCode: strings", () => {
  it("keeps string bodies verbatim when dropStrings is false", () => {
    expect(stripCode('a = "hello"', false)).toBe('a = "hello"');
    expect(stripCode("x = 'y'", false)).toBe("x = 'y'");
    expect(stripCode("t = `z`", false)).toBe("t = `z`");
  });
  it("drops string bodies to a single space when dropStrings is true", () => {
    expect(stripCode('a = "hello"', true)).toBe("a =  ");
  });
  it("respects an escaped quote inside a KEPT string (does not end early)", () => {
    expect(stripCode('"a\\"b"', false)).toBe('"a\\"b"');
  });
  it("respects an escaped quote inside a DROPPED string (does not end early)", () => {
    expect(stripCode('"a\\"b"', true)).toBe(" ");
  });
  it("treats // inside a KEPT string as string content, not a comment", () => {
    expect(stripCode('u = "http://x"', false)).toBe('u = "http://x"');
  });
});

describe("containsCall: call patterns (end with '(')", () => {
  it("matches a bare call", () => {
    expect(containsCall("fetch(url)", "fetch(")).toBe(true);
  });
  it("does NOT match when the call name is the tail of a longer identifier", () => {
    expect(containsCall("_metar_fetch(x)", "fetch(")).toBe(false);
    expect(containsCall("rerun()", "run(")).toBe(false);
  });
  it("matches across a member-access dot (analytics.track( -> track()", () => {
    expect(containsCall("analytics.track(e)", "track(")).toBe(true);
  });
  it("a punct-leading call pattern (.forEach() matches by bare containment", () => {
    expect(containsCall("arr.forEach(f)", ".forEach(")).toBe(true);
    expect(containsCall("nothing here", ".forEach(")).toBe(false);
  });
});

describe("containsCall: non-call tokens", () => {
  it("a punct-leading dotfile token does NOT match a property access", () => {
    expect(containsCall("process.env", ".env")).toBe(false);
  });
  it("a punct-leading dotfile token matches when preceded by a boundary", () => {
    expect(containsCall("cat .env", ".env")).toBe(true);
    expect(containsCall(".env", ".env")).toBe(true);
  });
  it("an identifier-leading token in a prose sentence is a mention, not code", () => {
    expect(containsCall("use a try-catch block here", "try-catch")).toBe(false);
  });
  it("the same token bounded by quotes (a real specifier) still matches", () => {
    expect(containsCall('import x from "try-catch"', "try-catch")).toBe(true);
  });
});

describe("stripCode: edge inputs (unterminated / escapes that matter)", () => {
  it("an unterminated KEPT string runs to end of input, no closing quote invented", () => {
    expect(stripCode('a "bc', false)).toBe('a "bc');
  });
  it("an unterminated DROPPED string runs to end of input", () => {
    expect(stripCode('a "bc', true)).toBe("a  ");
  });
  it("an escaped quote does NOT end a KEPT string early (text after it survives)", () => {
    expect(stripCode('"a\\"b" c', false)).toBe('"a\\"b" c');
  });
  it("an escaped quote does NOT end a DROPPED string early", () => {
    expect(stripCode('"a\\"b" c', true)).toBe("  c");
  });
  it("an unterminated block comment runs to end of input", () => {
    expect(stripCode("a /* bc", false)).toBe("a  ");
  });
  it("an unterminated // line comment runs to end of input", () => {
    expect(stripCode("a //bc", false)).toBe("a ");
  });
});

describe("editedContentFromEvent: null-safety and field type", () => {
  it("does not throw when input is absent (optional chaining)", () => {
    expect(editedContentFromEvent({ role: "assistant", kind: "tool_use", toolName: "Write", timestamp: "t" } as TranscriptEvent)).toBeNull();
  });
  it("returns null for an Edit whose new_string is not a string", () => {
    expect(editedContentFromEvent({ role: "assistant", kind: "tool_use", toolName: "Edit", input: { file_path: "a.ts", new_string: 123 }, timestamp: "t" } as TranscriptEvent)).toBeNull();
  });
});

describe("containsCall: isCall branch and punct-token prose", () => {
  it("a CALL pattern in a prose-sandwich still matches (the prose guard is non-call only)", () => {
    expect(containsCall("use a fetch( here", "fetch(")).toBe(true);
  });
  it("a punct-leading dotfile token matches even inside prose (no sandwich guard on that branch)", () => {
    expect(containsCall("edit the .env file", ".env")).toBe(true);
  });
});

describe("isProseSandwich", () => {
  it("true when a lowercase word+space precedes and space+lowercase word follows", () => {
    expect(isProseSandwich("a fetch b", 2, "fetch")).toBe(true);
  });
  it("false when the char before is not a lowercase+space (e.g. a quote)", () => {
    expect(isProseSandwich('"fetch" b', 1, "fetch")).toBe(false);
  });
  it("false when the char after is not space+lowercase (e.g. an open paren)", () => {
    expect(isProseSandwich("a fetch(x)", 2, "fetch")).toBe(false);
  });
});
