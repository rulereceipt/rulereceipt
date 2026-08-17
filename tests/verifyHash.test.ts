import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifySessionHash } from "../src/verifyHash.js";
import { computeTranscriptHash } from "../src/report/generateReport.js";

function makeSessionFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "rulereceipt-verify-test-"));
  const file = join(dir, "session.jsonl");
  writeFileSync(file, content);
  return file;
}

describe("verifySessionHash", () => {
  it("MATCHes on the full 64-char hash", () => {
    const file = makeSessionFile('{"type":"user","message":{"content":"hi"}}\n');
    const full = computeTranscriptHash(file);
    const result = verifySessionHash(file, full!);
    expect(result.match).toBe(true);
    expect(result.fullHash).toBe(full);
  });

  // this is the actual real-world case: a report only ever prints the
  // first 16 hex chars + "..." (see generateReport.ts), never the full
  // hash — verification must work against exactly what a report shows
  it("MATCHes on the truncated 16-char + '...' form a real report prints", () => {
    const file = makeSessionFile('{"type":"user","message":{"content":"hi"}}\n');
    const full = computeTranscriptHash(file)!;
    const truncated = `sha256:${full.slice(0, 16)}...`;
    const result = verifySessionHash(file, truncated);
    expect(result.match).toBe(true);
  });

  it("MATCHes regardless of case", () => {
    const file = makeSessionFile('{"type":"user","message":{"content":"hi"}}\n');
    const full = computeTranscriptHash(file)!;
    const result = verifySessionHash(file, full.slice(0, 12).toUpperCase());
    expect(result.match).toBe(true);
  });

  it("MISMATCHes when the file content differs from the claimed hash", () => {
    const file = makeSessionFile('{"type":"user","message":{"content":"hi"}}\n');
    const result = verifySessionHash(file, "0000000000000000");
    expect(result.match).toBe(false);
  });

  // proves this can actually fail: a hash from a DIFFERENT real file
  // must not match this one, even though both are real valid hashes
  it("MISMATCHes against a hash from a genuinely different file (sanity check)", () => {
    const fileA = makeSessionFile('{"type":"user","message":{"content":"hi"}}\n');
    const fileB = makeSessionFile('{"type":"user","message":{"content":"bye"}}\n');
    const hashB = computeTranscriptHash(fileB)!;
    const result = verifySessionHash(fileA, hashB);
    expect(result.match).toBe(false);
  });

  it("returns fullHash: null, not a throw, for a missing file", () => {
    expect(() => verifySessionHash("/definitely/not/a/real/file.jsonl", "abc")).not.toThrow();
    const result = verifySessionHash("/definitely/not/a/real/file.jsonl", "abc");
    expect(result.fullHash).toBeNull();
    expect(result.match).toBe(false);
  });

  it("does not MATCH on an empty claimed hash", () => {
    const file = makeSessionFile('{"type":"user","message":{"content":"hi"}}\n');
    const result = verifySessionHash(file, "");
    expect(result.match).toBe(false);
  });
});
