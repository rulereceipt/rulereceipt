import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { parseCodexLine } from "../src/adapters/codex.js";
import { parseClaudeMd } from "../src/parsers/readClaudeMd.js";
import { stripTerminalEscapes } from "../src/sanitize.js";
import { readTranscriptFromFile } from "../src/parsers/transcriptParser.js";
import { parseCopilotTranscript, copilotFormatIsKnown } from "../src/adapters/copilot.js";
import { parseCursorTranscript, cursorFormatIsKnown } from "../src/adapters/cursor.js";
import { parseAntigravityTranscript, antigravityFormatIsKnown } from "../src/adapters/antigravity.js";
import { parseClineTranscript, clineFormatIsKnown } from "../src/adapters/cline.js";
import { parseOpenCodeTranscript, openCodeFormatIsKnown } from "../src/adapters/opencode.js";
import { parseDevinTranscript, devinFormatIsKnown } from "../src/adapters/devin.js";
import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

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

/**
 * Every agent adapter reads UNTRUSTED session files. For ANY input — garbage
 * bytes, malformed JSON/JSONL, huge values, control sequences — the parser and
 * its format-detector must return cleanly (empty events / false), never throw or
 * hang. One file-per-call keeps the fuzzer fast; the db-backed adapters are
 * fuzzed on their own untrusted surface (the JSON blobs inside the db) below.
 */
describe("agent adapter fuzzing (file-based) — never throw on arbitrary input", () => {
  const fileParsers: { name: string; parse: (f: string) => unknown; known: (f: string) => boolean; ext: string }[] = [
    { name: "copilot", parse: parseCopilotTranscript, known: copilotFormatIsKnown, ext: ".jsonl" },
    { name: "cursor", parse: parseCursorTranscript, known: cursorFormatIsKnown, ext: ".jsonl" },
    { name: "antigravity", parse: parseAntigravityTranscript, known: antigravityFormatIsKnown, ext: ".jsonl" },
    { name: "cline", parse: parseClineTranscript, known: clineFormatIsKnown, ext: ".json" },
    { name: "opencode", parse: parseOpenCodeTranscript, known: openCodeFormatIsKnown, ext: ".json" },
  ];
  for (const p of fileParsers) {
    it(`${p.name}: parse + format-detect never throw on garbage files`, () => {
      const dir = mkdtempSync(join(tmpdir(), `rr-fuzz-${p.name}-`));
      try {
        const f = join(dir, `s${p.ext}`);
        fc.assert(fc.property(fc.array(fuzz, { maxLength: 60 }), (lines) => {
          writeFileSync(f, lines.join("\n"));
          p.known(f);
          p.parse(f);
          return true;
        }), { numRuns: 120 });
        // Pathological: a huge single line, and deeply nested JSON.
        writeFileSync(f, '{"a":' + "[".repeat(3000) + "]".repeat(3000) + "}");
        expect(() => { p.known(f); p.parse(f); }).not.toThrow();
        writeFileSync(f, '{"messages":"' + "x".repeat(200000) + '"}');
        expect(() => { p.known(f); p.parse(f); }).not.toThrow();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

// The SQLite-backed adapters (OpenCode, Devin) carry their untrusted data in JSON
// blobs inside the db (message_nodes.chat_message, part.data). Build a real db,
// fill those blobs with fuzz, and confirm the parser swallows it. Skipped where
// node:sqlite is absent (Node < 22.5), the same degradation the readers do.
let DatabaseSync: (new (p: string) => { exec(s: string): void; prepare(s: string): { run(...a: unknown[]): void }; close(): void }) | undefined;
try { DatabaseSync = createRequire(import.meta.url)("node:sqlite").DatabaseSync; } catch { /* older Node */ }
const sqliteDescribe = DatabaseSync ? describe : describe.skip;

sqliteDescribe("db-backed adapter fuzzing — fuzz the JSON blobs inside the db", () => {
  it("Devin: a fuzzed chat_message blob never throws", () => {
    const dir = mkdtempSync(join(tmpdir(), "rr-fuzz-devindb-"));
    try {
      const dbPath = join(dir, "cli", "sessions.db");
      mkdirSync(join(dbPath, ".."), { recursive: true });
      const db = new DatabaseSync!(dbPath);
      db.exec("CREATE TABLE sessions (id TEXT, working_directory TEXT, main_chain_id INTEGER, hidden INTEGER DEFAULT 0, last_activity_at INTEGER)");
      db.exec("CREATE TABLE message_nodes (row_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, node_id INTEGER, parent_node_id INTEGER, chat_message TEXT, created_at INTEGER)");
      db.prepare("INSERT INTO sessions VALUES (?,?,?,?,?)").run("s", dir, 0, 0, 1);
      const ins = db.prepare("INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at) VALUES (?,?,?,?,?)");
      db.close();
      const handle = `${dbPath}#s`;
      fc.assert(fc.property(fuzz, (blob) => {
        const w = new DatabaseSync!(dbPath);
        w.prepare("DELETE FROM message_nodes").run();
        w.close();
        const w2 = new DatabaseSync!(dbPath);
        w2.prepare("INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at) VALUES (?,?,?,?,?)").run("s", 0, null, blob, 1);
        w2.close();
        devinFormatIsKnown(handle);
        parseDevinTranscript(handle);
        return true;
      }), { numRuns: 120 });
      void ins;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("OpenCode: a fuzzed part.data blob never throws", () => {
    const dir = mkdtempSync(join(tmpdir(), "rr-fuzz-ocdb-"));
    try {
      const dbPath = join(dir, "opencode.db");
      const db = new DatabaseSync!(dbPath);
      db.exec("CREATE TABLE session (id TEXT, directory TEXT, time_updated INTEGER, time_archived INTEGER)");
      db.exec("CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT)");
      db.exec("CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)");
      db.prepare("INSERT INTO session VALUES (?,?,?,?)").run("ses_f", dir, 1, null);
      db.prepare("INSERT INTO message VALUES (?,?,?,?)").run("m", "ses_f", 1, JSON.stringify({ role: "assistant" }));
      db.close();
      const handle = `${dbPath}#ses_f`;
      fc.assert(fc.property(fuzz, (blob) => {
        const w = new DatabaseSync!(dbPath);
        w.prepare("DELETE FROM part").run();
        w.prepare("INSERT INTO part VALUES (?,?,?,?,?)").run("p", "m", "ses_f", 1, blob);
        w.close();
        openCodeFormatIsKnown(handle);
        parseOpenCodeTranscript(handle);
        return true;
      }), { numRuns: 120 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
