import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { parseCodexLine } from "../src/adapters/codex.js";
import { parseClaudeMd } from "../src/parsers/readClaudeMd.js";
import { stripTerminalEscapes } from "../src/sanitize.js";
import { readTranscriptFromFile } from "../src/parsers/transcriptParser.js";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Property-based fuzzing of the parsers (pre-launch security pass). They read
 * UNTRUSTED input, so for ANY input they must never crash, hang, or let a
 * control sequence survive to display. fast-check generates the inputs and
 * shrinks any failure to a minimal reproducer.
 *
 * `fuzz` mixes ordinary text with the bytes most likely to break a parser:
 * JSON punctuation, terminal escapes/control chars, multibyte and astral code
 * points, and lone surrogates (invalid UTF-16).
 */
const fuzz = fc
  .array(
    fc.oneof(
      // Any UTF-16 code unit: covers C0/C1 controls, ESC, JSON punctuation, and
      // LONE surrogates (0xD800-0xDFFF) — i.e. invalid UTF-16.
      fc.integer({ min: 0, max: 0xffff }).map((c) => String.fromCharCode(c)),
      // A few astral code points and JSON structure characters, weighted in.
      fc.constantFrom("😀", "λ", "\u{10000}", "{", "}", "[", "]", '"', ":", ",", "\\", "\u001b", "\u0007")
    ),
    { maxLength: 4000 }
  )
  .map((a) => a.join(""));

describe("parser fuzzing (fast-check) — never crash / hang / leak control codes", () => {
  it("parseCodexLine never throws on arbitrary input", () => {
    fc.assert(fc.property(fuzz, (s) => { parseCodexLine(s); return true; }), { numRuns: 3000 });
  });

  it("parseCodexLine survives pathological shapes (deep nesting, huge values)", () => {
    expect(() => parseCodexLine("{" + '"a":'.repeat(5000) + "1" + "}".repeat(5000))).not.toThrow();
    expect(() => parseCodexLine('{"type":"response_item","payload":{"type":"message","content":"' + "x".repeat(200000) + '"}}')).not.toThrow();
  });

  it("parseClaudeMd never throws on arbitrary rules-file content", () => {
    const dir = mkdtempSync(join(tmpdir(), "rr-fuzz-"));
    try {
      const f = join(dir, "CLAUDE.md");
      fc.assert(fc.property(fuzz, (s) => { writeFileSync(f, s); parseClaudeMd(f, "project"); return true; }), { numRuns: 300 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("readTranscriptFromFile survives a garbage/huge/escape-laden JSONL file", () => {
    const dir = mkdtempSync(join(tmpdir(), "rr-fuzz2-"));
    try {
      fc.assert(
        fc.property(fc.array(fuzz, { maxLength: 200 }), (lines) => {
          const f = join(dir, "s.jsonl");
          writeFileSync(f, lines.join("\n") + "\n" + "x".repeat(100000));
          readTranscriptFromFile(f);
          return true;
        }),
        { numRuns: 100 }
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("no control code survives stripTerminalEscapes, for any input", () => {
    fc.assert(
      fc.property(fuzz, (s) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/.test(stripTerminalEscapes(s))),
      { numRuns: 3000 }
    );
  });
});
