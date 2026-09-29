import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listAllSessionFiles } from "../src/parsers/transcriptParser.js";

/**
 * Session discovery must not depend on guessing Claude Code's folder-name
 * encoding. A project whose path has a dot, underscore or space (john.doe,
 * my_project, "My Work") found 0 sessions on 0.1.74 — the whole first screen
 * said "No sessions found". The fix matches on the real `cwd` stored inside the
 * session file, so any path — and monorepo subfolders — are found.
 */
let root: string;
let cfg: string;
const prevCfg = process.env.CLAUDE_CONFIG_DIR;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rr-disc-"));
  cfg = join(root, "claude-home");
  mkdirSync(join(cfg, "projects"), { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = cfg;
});
afterEach(() => {
  if (prevCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prevCfg;
  rmSync(root, { recursive: true, force: true });
});

/** A real project dir on disk (so realpath resolves) with a markers file. */
function makeProject(relPath: string, markers = true): string {
  const p = join(root, relPath);
  mkdirSync(p, { recursive: true });
  if (markers) writeFileSync(join(p, "CLAUDE.md"), "- Never push to main.\n");
  return p;
}

/** A session folder whose NAME need not match any encoding — matched by stored cwd. */
function makeSession(folderName: string, sessionCwd: string): string {
  const dir = join(cfg, "projects", folderName);
  mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({ type: "user", cwd: sessionCwd, timestamp: "2026-09-28T10:00:00Z", message: { role: "user", content: "hi" } });
  const file = join(dir, "11111111-1111-1111-1111-111111111111.jsonl");
  writeFileSync(file, line + "\n");
  return file;
}

describe("listAllSessionFiles — ground-truth cwd matching", () => {
  it("finds sessions for a path containing a DOT (john.doe / my.app)", () => {
    const proj = makeProject("Users/john.doe/my.app");
    const file = makeSession("literally-any-folder-name", proj);
    expect(listAllSessionFiles(proj)).toContain(file);
  });

  it("finds sessions for a path with an UNDERSCORE", () => {
    const proj = makeProject("work/my_project");
    const file = makeSession("some-encoded-name", proj);
    expect(listAllSessionFiles(proj)).toContain(file);
  });

  it("finds sessions for a path with a SPACE", () => {
    const proj = makeProject("work/My Work");
    const file = makeSession("folder", proj);
    expect(listAllSessionFiles(proj)).toContain(file);
  });

  it("MONOREPO: a session started in packages/api is found from the repo root", () => {
    const rootProj = makeProject("mono"); // has CLAUDE.md + is a root
    const sub = join(rootProj, "packages/api");
    mkdirSync(sub, { recursive: true });
    const file = makeSession("mono-packages-api", sub);
    expect(listAllSessionFiles(rootProj)).toContain(file);
  });

  it("does NOT pull in an unrelated project's sessions", () => {
    const a = makeProject("projA");
    const b = makeProject("projB");
    const fileB = makeSession("projB-folder", b);
    expect(listAllSessionFiles(a)).not.toContain(fileB);
  });

  it("honors CLAUDE_CONFIG_DIR as a search root", () => {
    // The only home configured in this test IS CLAUDE_CONFIG_DIR; a hit proves it is searched.
    const proj = makeProject("plain");
    const file = makeSession("plain-folder", proj);
    expect(listAllSessionFiles(proj)).toContain(file);
  });

  it("falls back to name encoding when the stored cwd is unreadable", () => {
    const proj = makeProject("fallback.dir"); // dot -> all-non-alnum encoding
    const encoded = proj.replace(/[^A-Za-z0-9]/g, "-");
    const dir = join(cfg, "projects", encoded);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "22222222-2222-2222-2222-222222222222.jsonl");
    writeFileSync(file, "not json, no cwd here\n"); // unreadable cwd -> encoding fallback
    expect(listAllSessionFiles(proj)).toContain(file);
  });
});
