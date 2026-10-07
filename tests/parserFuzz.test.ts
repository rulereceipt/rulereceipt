import { describe, it, expect } from "vitest";
import { parseCodexLine } from "../src/adapters/codex.js";
import { parseClaudeMd } from "../src/parsers/readClaudeMd.js";
import { stripTerminalEscapes } from "../src/sanitize.js";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTranscriptFromFile } from "../src/parsers/transcriptParser.js";

/**
 * Parser fuzzing (pre-launch security pass). The transcript and rules parsers
 * read UNTRUSTED input, so they must never crash, hang, or let a control
 * sequence survive to display. Deterministic PRNG (seeded) so a failure
 * reproduces. No new dependency.
 */
function prng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0xffffffff);
}
function randomString(r: () => number, n: number): string {
  const pools = ["{}[]\":,", "\u001b[]8;0m\u0007\u0008\u0000", "aA1 \n\t", "😀λ\u{10000}", "𐀀\uDFFF"];
  let out = "";
  for (let i = 0; i < n; i++) {
    const pool = pools[Math.floor(r() * pools.length)];
    out += pool[Math.floor(r() * pool.length)];
  }
  return out;
}

describe("parser fuzzing — never crash / hang / leak control codes", () => {
  it("parseCodexLine survives 5000 garbage lines in well under 2s", () => {
    const r = prng(42);
    const start = performance.now();
    for (let i = 0; i < 5000; i++) {
      const len = Math.floor(r() * 2000);
      expect(() => parseCodexLine(randomString(r, len))).not.toThrow();
    }
    // a few pathological shapes
    expect(() => parseCodexLine("{" + '"a":'.repeat(5000) + "1" + "}".repeat(5000))).not.toThrow();
    expect(() => parseCodexLine('{"type":"response_item","payload":{"type":"message","content":"' + "x".repeat(200000) + '"}}')).not.toThrow();
    expect(performance.now() - start).toBeLessThan(2000);
  });

  it("parseClaudeMd survives garbage rules files fast", () => {
    const r = prng(7);
    const dir = mkdtempSync(join(tmpdir(), "rr-fuzz-"));
    try {
      const start = performance.now();
      for (let i = 0; i < 300; i++) {
        const f = join(dir, "CLAUDE.md");
        writeFileSync(f, randomString(r, Math.floor(r() * 4000)));
        expect(() => parseClaudeMd(f, "project")).not.toThrow();
      }
      expect(performance.now() - start).toBeLessThan(2000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("readTranscriptFromFile survives a garbage/huge/escape-laden JSONL file", () => {
    const r = prng(99);
    const dir = mkdtempSync(join(tmpdir(), "rr-fuzz2-"));
    try {
      const f = join(dir, "s.jsonl");
      const lines = [];
      for (let i = 0; i < 500; i++) lines.push(randomString(r, Math.floor(r() * 3000)));
      lines.push("x".repeat(500000)); // one huge line
      writeFileSync(f, lines.join("\n"));
      const start = performance.now();
      expect(() => readTranscriptFromFile(f)).not.toThrow();
      expect(performance.now() - start).toBeLessThan(2000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("no control code survives stripTerminalEscapes, for any fuzzed input", () => {
    const r = prng(123);
    for (let i = 0; i < 2000; i++) {
      const out = stripTerminalEscapes(randomString(r, Math.floor(r() * 300)));
      // only \n and \t are allowed control chars after stripping
      expect(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/.test(out)).toBe(false);
    }
  });
});
