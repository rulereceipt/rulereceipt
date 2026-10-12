import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { readTranscriptFromFile } from "../src/parsers/transcriptParser.js";
import { parseCopilotTranscript } from "../src/adapters/copilot.js";
import { parseCursorTranscript } from "../src/adapters/cursor.js";
import { parseAntigravityTranscript } from "../src/adapters/antigravity.js";
import { parseClineTranscript } from "../src/adapters/cline.js";
import { parseOpenCodeTranscript } from "../src/adapters/opencode.js";
import { parseDevinTranscript } from "../src/adapters/devin.js";
import { evaluateSession } from "../src/evaluate.js";
import type { Rule, TranscriptEvent, CheckResult } from "../src/types.js";

/**
 * Robustness (correctness-program): a bad, truncated, or huge session file must
 * never crash (covered in parserFuzz.test.ts) AND must never manufacture a FAIL.
 * A FAIL is an accusation; garbage that contains no real forbidden action must
 * never produce one. Here each of the 8 readers is fed garbage, its events are
 * run through the real engine with a set of ARMED forbidding rules, and the
 * result must carry zero FAIL. (No-throw is asserted too, as a bonus.)
 */
const llmStub = (r: Rule): CheckResult => ({ ruleId: r.id, ruleTitle: r.title, ruleSource: r.source, status: "UNCLEAR", evidence: "stub" });
// Rules that WOULD FAIL on a real violation, so the engine is genuinely armed.
const ARMED: Rule[] = [
  { id: "1", title: "No push to main", text: "Never push to the `main` branch.", source: "project" },
  { id: "2", title: "No console.log", text: "Never write `console.log(` into a committed file.", source: "project" },
  { id: "3", title: "No editing .env", text: "Never edit the `.env` file.", source: "project" },
  { id: "4", title: "No AI co-author", text: "Never add a `Co-Authored-By` trailer.", source: "project" },
  { id: "5", title: "No emoji", text: "Never put emoji in output.", source: "project" },
  { id: "6", title: "Tests before done", text: "Do not claim done until `npm test` passes.", source: "project" },
];

const GARBAGE: string[] = [
  "",
  "   \n\t ",
  "not json at all {{{",
  '{"truncated":',
  '{"type":"user"}\n{"broken',
  "\u0000\u0001\u0002 control bytes \u009b[31m",
  "x".repeat(200000),
  '{"a":' .repeat(2000) + "1" + "}".repeat(2000),
  '[]',
  'null',
  "😀😀😀 \\n emoji-and-escapes \\u0000",
];

let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "rr-nofail-")); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function assertNoFail(events: TranscriptEvent[], label: string): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), "rr-nofail-cwd-"));
  try {
    const { results } = await evaluateSession(cwd, ARMED, events, false, llmStub);
    const fails = results.filter((r) => r.status === "FAIL");
    expect(fails, `${label}: garbage produced FAIL(s): ${JSON.stringify(fails.map((f) => f.evidence))}`).toHaveLength(0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

type FileReader = { name: string; ext: string; parse: (p: string) => TranscriptEvent[] };
const FILE_READERS: FileReader[] = [
  { name: "claude/codex (sniffed)", ext: ".jsonl", parse: readTranscriptFromFile },
  { name: "copilot", ext: ".jsonl", parse: parseCopilotTranscript },
  { name: "cursor", ext: ".jsonl", parse: parseCursorTranscript },
  { name: "antigravity", ext: ".jsonl", parse: parseAntigravityTranscript },
  { name: "cline", ext: ".json", parse: parseClineTranscript },
  { name: "opencode (json)", ext: ".json", parse: parseOpenCodeTranscript },
];

describe("robustness: garbage files never produce a FAIL (file-based readers)", () => {
  for (const r of FILE_READERS) {
    it(`${r.name}: no FAIL on any garbage payload`, async () => {
      for (const [i, g] of GARBAGE.entries()) {
        const f = join(dir, `${r.name.replace(/[^a-z]/gi, "")}-${i}${r.ext}`);
        writeFileSync(f, g);
        let events: TranscriptEvent[] = [];
        expect(() => { events = r.parse(f); }, `${r.name} threw on payload ${i}`).not.toThrow();
        await assertNoFail(events, `${r.name} payload ${i}`);
      }
    });
  }
});

// SQLite-backed readers (Devin, OpenCode-db): garbage in the JSON blobs. Skipped
// below Node 22.5 (no node:sqlite), the same degradation the readers themselves do.
let DatabaseSync: (new (p: string) => { exec(s: string): void; prepare(s: string): { run(...a: unknown[]): void }; close(): void }) | undefined;
try { DatabaseSync = createRequire(import.meta.url)("node:sqlite").DatabaseSync; } catch { /* older Node */ }
const sqliteDescribe = DatabaseSync ? describe : describe.skip;

sqliteDescribe("robustness: garbage blobs never produce a FAIL (db-backed readers)", () => {
  it("Devin: no FAIL on a garbage chat_message blob", async () => {
    const d = mkdtempSync(join(tmpdir(), "rr-nofail-devindb-"));
    try {
      const dbPath = join(d, "cli", "sessions.db");
      mkdirSync(join(dbPath, ".."), { recursive: true });
      let db = new DatabaseSync!(dbPath);
      db.exec("CREATE TABLE sessions (id TEXT, working_directory TEXT, main_chain_id INTEGER, hidden INTEGER DEFAULT 0, last_activity_at INTEGER)");
      db.exec("CREATE TABLE message_nodes (row_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, node_id INTEGER, parent_node_id INTEGER, chat_message TEXT, created_at INTEGER)");
      db.prepare("INSERT INTO sessions VALUES (?,?,?,?,?)").run("s", d, 0, 0, 1);
      db.close();
      const handle = `${dbPath}#s`;
      for (const [i, g] of GARBAGE.entries()) {
        db = new DatabaseSync!(dbPath);
        db.prepare("DELETE FROM message_nodes").run();
        db.prepare("INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at) VALUES (?,?,?,?,?)").run("s", 0, null, g, 1);
        db.close();
        let events: TranscriptEvent[] = [];
        expect(() => { events = parseDevinTranscript(handle); }, `devin threw on payload ${i}`).not.toThrow();
        await assertNoFail(events, `devin payload ${i}`);
      }
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it("OpenCode-db: no FAIL on a garbage part.data blob", async () => {
    const d = mkdtempSync(join(tmpdir(), "rr-nofail-ocdb-"));
    try {
      const dbPath = join(d, "opencode.db");
      let db = new DatabaseSync!(dbPath);
      db.exec("CREATE TABLE session (id TEXT, directory TEXT, time_updated INTEGER, time_archived INTEGER)");
      db.exec("CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT)");
      db.exec("CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)");
      db.prepare("INSERT INTO session VALUES (?,?,?,?)").run("ses_f", d, 1, null);
      db.prepare("INSERT INTO message VALUES (?,?,?,?)").run("m", "ses_f", 1, JSON.stringify({ role: "assistant" }));
      db.close();
      const handle = `${dbPath}#ses_f`;
      for (const [i, g] of GARBAGE.entries()) {
        db = new DatabaseSync!(dbPath);
        db.prepare("DELETE FROM part").run();
        db.prepare("INSERT INTO part VALUES (?,?,?,?,?)").run("p", "m", "ses_f", 1, g);
        db.close();
        let events: TranscriptEvent[] = [];
        expect(() => { events = parseOpenCodeTranscript(handle); }, `opencode-db threw on payload ${i}`).not.toThrow();
        await assertNoFail(events, `opencode-db payload ${i}`);
      }
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});
