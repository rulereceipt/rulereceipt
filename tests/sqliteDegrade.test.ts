import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { parseOpenCodeTranscript, listOpenCodeSessions, sqliteUnavailableWarning } from "../src/adapters/opencode.js";

/**
 * Regression guards for the two Node/SQLite footguns (reported 2026-10-09):
 *   1. `node:sqlite` is experimental on Node 22/23, so requiring it EAGERLY
 *      printed "SQLite is an experimental feature" on every `check`/`doctor`,
 *      even for a plain Claude Code project that never opens a db. Fix: load it
 *      lazily (only when an opencode.db is actually read) and mute that one
 *      warning. These tests prove the CLI prints no warnings, and that the
 *      adapter does not pull in node:sqlite merely by being imported.
 *   2. `engines` allows Node >=20 but node:sqlite needs 22.5+. On older Node the
 *      db-backed path must degrade (skip + one clear line), never crash.
 *      `RR_FORCE_NO_SQLITE=1` forces that path so it is testable on any Node.
 */

const CLI = join(process.cwd(), "dist", "cli.js");

describe("CLI prints no process warnings (lazy node:sqlite)", () => {
  it("check / doctor / --version emit no 'Warning' on stderr", () => {
    const dir = mkdtempSync(join(tmpdir(), "rr-nowarn-"));
    try {
      writeFileSync(join(dir, "CLAUDE.md"), "# CLAUDE.md\n\nRule 1: always run tests.\n");
      for (const args of [["--version"], ["doctor"], ["check"]]) {
        const r = spawnSync("node", [CLI, ...args], { cwd: dir, encoding: "utf-8" });
        const stderr = r.stderr ?? "";
        expect(stderr, `stderr for \`${args.join(" ")}\``).not.toMatch(/Warning/i);
        expect(stderr).not.toMatch(/SQLite is an experimental feature/i);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("importing the OpenCode adapter does not load node:sqlite", () => {
    // Node-version independent: before the fix the module required node:sqlite
    // eagerly (what printed the warning); after it, nothing loads node:sqlite
    // until a db is actually read.
    const probe = [
      'import("./dist/adapters/opencode.js").then(() => {',
      '  const loaded = process.moduleLoadList.some(m => /sqlite/i.test(m));',
      '  process.stdout.write(loaded ? "LOADED" : "NOT_LOADED");',
      '});',
    ].join("\n");
    const r = spawnSync("node", ["--input-type=module", "-e", probe], { cwd: process.cwd(), encoding: "utf-8" });
    expect(r.stdout).toBe("NOT_LOADED");
  });
});

// node:sqlite presence gates the real-db degrade test (skipped on Node < 22.5).
let hasSqlite = false;
try { createRequire(import.meta.url)("node:sqlite"); hasSqlite = true; } catch { /* older Node */ }
const sqliteDescribe = hasSqlite ? describe : describe.skip;

sqliteDescribe("old-Node degrade path (RR_FORCE_NO_SQLITE simulates <22.5)", () => {
  function buildDb(dbPath: string, directory: string) {
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (p: string) => { exec(s: string): void; prepare(s: string): { run(...a: unknown[]): void }; close(): void } };
    mkdirSync(join(dbPath, ".."), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE session (id TEXT, directory TEXT, time_updated INTEGER, time_archived INTEGER)");
    db.exec("CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT)");
    db.exec("CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)");
    db.prepare("INSERT INTO session VALUES (?,?,?,?)").run("ses_t1", directory, 1000, null);
    db.prepare("INSERT INTO message VALUES (?,?,?,?)").run("m1", "ses_t1", 1, JSON.stringify({ role: "user" }));
    db.prepare("INSERT INTO part VALUES (?,?,?,?,?)").run("p1", "m1", "ses_t1", 1, JSON.stringify({ type: "text", text: "ship it" }));
    db.close();
  }

  it("with sqlite forced off: reading a db handle returns [] and does NOT throw", () => {
    const tmp = mkdtempSync(join(tmpdir(), "rr-degrade-"));
    const prev = process.env.RR_FORCE_NO_SQLITE;
    try {
      const dbPath = join(tmp, "opencode.db");
      buildDb(dbPath, join(tmp, "proj"));
      process.env.RR_FORCE_NO_SQLITE = "1";
      const handle = `${dbPath}#ses_t1`;
      expect(() => parseOpenCodeTranscript(handle)).not.toThrow();
      expect(parseOpenCodeTranscript(handle)).toEqual([]);
      expect(() => listOpenCodeSessions(join(tmp, "proj"))).not.toThrow();
    } finally {
      if (prev === undefined) delete process.env.RR_FORCE_NO_SQLITE; else process.env.RR_FORCE_NO_SQLITE = prev;
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("old-Node warning wording", () => {
  it("names the agent and says it needs Node 22.5+", () => {
    const msg = sqliteUnavailableWarning("OpenCode");
    expect(msg).toMatch(/OpenCode/);
    expect(msg).toMatch(/Node 22\.5\+/);
  });
});
