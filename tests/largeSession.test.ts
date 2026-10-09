import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, openSync, writeSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { readTranscriptWithCoverage, readTranscriptFromFile, readBoundedText, transcriptCoverage } from "../src/parsers/transcriptParser.js";
import { loadRules, lastRuleScanInfo } from "../src/rules.js";

/**
 * Regression guards for the 2026-10-09 hang: `check`/`report` must not hang or
 * OOM on a huge session. Before the fix, readTranscriptFromFile did
 * `readFileSync(wholeFile)` then `.split("\n")` — a 262 MB session on a dev
 * laptop hung the command. The reader now STREAMS with a byte + time budget, and
 * a short read is reported ("large session: checked X of Y MB"), never silently
 * a Followed over the unread tail. The descendant rules-scan is likewise bounded.
 */

const asst = (text: string) => JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });

describe("large session: bounded streaming read (300 MB, time budget)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rr-big-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reads a 300 MB JSONL within a time budget, truncated, bounded, no throw", () => {
    const file = join(dir, "huge.jsonl");
    // Build ~300 MB by appending a ~1 MB block of valid JSONL lines many times.
    const line = asst("x".repeat(900)) + "\n";
    const block = line.repeat(Math.ceil((1024 * 1024) / line.length)); // ~1 MB
    const target = 300 * 1024 * 1024;
    const fd = openSync(file, "w");
    try { let written = 0; const b = Buffer.from(block); while (written < target) { writeSync(fd, b); written += b.length; } } finally { closeSync(fd); }

    const started = Date.now();
    const cov = readTranscriptWithCoverage(file, { maxBytes: 64 * 1024 * 1024, timeBudgetMs: 10_000 });
    const elapsed = Date.now() - started;

    expect(cov.truncated).toBe(true);
    expect(cov.totalBytes).toBeGreaterThan(290 * 1024 * 1024);
    expect(cov.bytesRead).toBeLessThanOrEqual(64 * 1024 * 1024 + 1024 * 1024); // budget + at most one chunk
    expect(cov.events.length).toBeGreaterThan(0); // the first 64 MB WAS parsed
    expect(elapsed).toBeLessThan(10_000); // the whole point: it does not hang
    // The plain wrapper must not throw either.
    expect(() => readTranscriptFromFile(file)).not.toThrow();
  }, 60_000);

  it("a small file is read whole (truncated=false) and matches event parity", () => {
    const file = join(dir, "small.jsonl");
    writeFileSync(file, [asst("hello"), asst("world")].join("\n") + "\n");
    const cov = readTranscriptWithCoverage(file);
    expect(cov.truncated).toBe(false);
    expect(cov.events.filter((e) => e.kind === "text").map((e) => (e as { text: string }).text)).toEqual(["hello", "world"]);
  });

  it("a tiny maxBytes truncates a multi-line file; readBoundedText/transcriptCoverage agree", () => {
    const file = join(dir, "multi.jsonl");
    const lines = Array.from({ length: 50 }, (_, i) => asst(`line ${i} ${"y".repeat(500)}`));
    writeFileSync(file, lines.join("\n") + "\n");
    const cov = readTranscriptWithCoverage(file, { maxBytes: 2000 });
    expect(cov.truncated).toBe(true);
    expect(cov.events.length).toBeGreaterThan(0);
    expect(cov.events.length).toBeLessThan(50); // not all lines were read
    expect(readBoundedText(file, 2000).truncated).toBe(true);
    expect(transcriptCoverage(file, 2000).truncated).toBe(true);
    expect(transcriptCoverage(file, 10_000_000).truncated).toBe(false);
  });
});

describe("large session: CLI downgrades clean verdicts to couldn't-tell on truncation", () => {
  let dir: string, home: string, prevHome: string | undefined, prevBudget: string | undefined;
  const CLI = join(process.cwd(), "dist", "cli.js");
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rr-bigcli-"));
    home = mkdtempSync(join(tmpdir(), "rr-bigcli-home-"));
    prevHome = process.env.HOME; prevBudget = process.env.RR_MAX_TRANSCRIPT_BYTES;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevBudget === undefined) delete process.env.RR_MAX_TRANSCRIPT_BYTES; else process.env.RR_MAX_TRANSCRIPT_BYTES = prevBudget;
    rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
  });

  it("over the (test-tiny) byte budget: says 'Large session' and the push is NOT reported Followed", () => {
    const proj = join(dir, "proj"); mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, "CLAUDE.md"), "## Branch\nNever push to the `main` branch without asking me first.\n");
    // A clean session: a push to a FEATURE branch (would normally be PASS/not-applicable
    // under a "push to main" rule) — placed at the start, then filler to exceed the budget.
    const push = JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "git push origin feature/x" } }] } });
    const lines = [JSON.stringify({ type: "user", message: { role: "user", content: "get my feature branch up to date" } }), push];
    for (let i = 0; i < 400; i++) lines.push(asst(`filler ${i} ${"z".repeat(50)}`));
    const file = join(proj, "s.jsonl");
    writeFileSync(file, lines.join("\n") + "\n");

    const r = spawnSync("node", [CLI, "check", "--transcript", file], {
      cwd: proj, encoding: "utf-8",
      env: { ...process.env, HOME: home, USERPROFILE: home, RR_MAX_TRANSCRIPT_BYTES: "2000" },
    });
    const out = (r.stdout ?? "") + (r.stderr ?? "");
    expect(out).toMatch(/Large session/i);
    // The push rule must NOT read as Followed when the session was only partly read.
    expect(out).not.toMatch(/✓ PASS[^\n]*push to .*main/i);
  }, 30_000);
});

describe("loadRules descendant scan is bounded (dir cap) and reports stopping early", () => {
  let dir: string, prevCap: string | undefined;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rr-scan-")); prevCap = process.env.RR_MAX_DESCEND_DIRS; });
  afterEach(() => { if (prevCap === undefined) delete process.env.RR_MAX_DESCEND_DIRS; else process.env.RR_MAX_DESCEND_DIRS = prevCap; rmSync(dir, { recursive: true, force: true }); });

  it("stops at the dir cap on a wide tree and flags stoppedEarly", () => {
    const proj = join(dir, "proj"); mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, "CLAUDE.md"), "## R\nRule one.\n");
    for (let i = 0; i < 10; i++) mkdirSync(join(proj, `sub${i}`), { recursive: true });
    process.env.RR_MAX_DESCEND_DIRS = "3";
    loadRules(proj, "claude-code");
    const info = lastRuleScanInfo();
    expect(info.stoppedEarly).toBe(true);
    expect(info.dirsScanned).toBeLessThanOrEqual(3);
  });

  it("does NOT flag stoppedEarly on a small tree under the cap", () => {
    const proj = join(dir, "proj"); mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, "CLAUDE.md"), "## R\nRule one.\n");
    mkdirSync(join(proj, "only"), { recursive: true });
    delete process.env.RR_MAX_DESCEND_DIRS;
    loadRules(proj, "claude-code");
    expect(lastRuleScanInfo().stoppedEarly).toBe(false);
  });
});
