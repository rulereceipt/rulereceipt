import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// rules-own-profile (0.1.107): a session's GLOBAL rules must come only from the
// Claude home that session belongs to, never from another configured ~/.claude*
// home (a separate or employer home a different session belongs to). This can
// only REMOVE a global rule that was never the session's — it can never add a
// verdict. Same homedir-mock approach as tests/loadRules.test.ts.
const homeState = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  homeState.current = actual.homedir();
  return { ...actual, homedir: () => homeState.current };
});

import { loadRules } from "../src/rules.js";
import { homeOwningSession } from "../src/parsers/transcriptParser.js";

describe("rules-own-profile: globals come only from the session's own home", () => {
  let tempHome: string;
  let projectDir: string;
  const realHome = homeState.current;
  let prevExtra: string | undefined;
  let homeA: string; // ~/.claude  (the session's own home)
  let homeB: string; // ~/.claude-b (another configured home)
  let sessionFile: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "rr-ownprofile-home-"));
    projectDir = mkdtempSync(join(tmpdir(), "rr-ownprofile-project-"));
    homeState.current = tempHome;
    prevExtra = process.env.RULERECEIPT_CLAUDE_HOMES;
    // Configure a SECOND home so claudeHomes() = [~/.claude, ~/.claude-b].
    process.env.RULERECEIPT_CLAUDE_HOMES = ".claude-b";

    homeA = join(tempHome, ".claude");
    homeB = join(tempHome, ".claude-b");
    mkdirSync(homeA, { recursive: true });
    mkdirSync(homeB, { recursive: true });
    writeFileSync(join(homeA, "CLAUDE.md"), "## Rule\n- marker-home-a\n");
    writeFileSync(join(homeB, "CLAUDE.md"), "## Rule\n- marker-home-b\n");

    // A real session lives at <home>/projects/<encoded-cwd>/<id>.jsonl.
    const projects = join(homeA, "projects", projectDir.replace(/\//g, "-"));
    mkdirSync(projects, { recursive: true });
    sessionFile = join(projects, "sess.jsonl");
    writeFileSync(sessionFile, "{}\n");
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
    homeState.current = realHome;
    if (prevExtra === undefined) delete process.env.RULERECEIPT_CLAUDE_HOMES;
    else process.env.RULERECEIPT_CLAUDE_HOMES = prevExtra;
  });

  function hasGlobal(rules: ReturnType<typeof loadRules>, marker: string): boolean {
    return rules.some((r) => r.source === "global" && (r.title.includes(marker) || r.text.includes(marker)));
  }

  it("homeOwningSession maps a session file to the home whose projects/ contains it", () => {
    expect(homeOwningSession(sessionFile)).toBe(homeA);
  });

  it("homeOwningSession returns null for a file outside every configured home (e.g. a --transcript copy)", () => {
    const outside = join(projectDir, "copied-session.jsonl");
    writeFileSync(outside, "{}\n");
    expect(homeOwningSession(outside)).toBeNull();
    expect(homeOwningSession(null)).toBeNull();
  });

  // The behavior the fix targets: with two homes configured and NO owner known,
  // loadRules still reads BOTH homes' globals. (This is the pre-fix path that a
  // session owned by home A should not be subject to — see the next test.)
  it("without an owner, globals from every configured home are loaded (the unrestricted default)", () => {
    const rules = loadRules(projectDir, "claude-code");
    expect(hasGlobal(rules, "marker-home-a")).toBe(true);
    expect(hasGlobal(rules, "marker-home-b")).toBe(true);
  });

  // The fix: restricted to the session's own home, the OTHER home's global rule
  // is not applied — a rule that was never this session's to begin with.
  it("restricted to the session's own home, the other home's global rule is NOT loaded", () => {
    const rules = loadRules(projectDir, "claude-code", { claudeHomes: [homeA] });
    expect(hasGlobal(rules, "marker-home-a")).toBe(true);
    expect(hasGlobal(rules, "marker-home-b")).toBe(false);
  });

  // Default single-home case (the FA corpus / 44-session snapshot run this way):
  // restricting to the only home is identical to the unrestricted read.
  it("single configured home: restriction is a no-op (no verdict can change)", () => {
    delete process.env.RULERECEIPT_CLAUDE_HOMES;
    const unrestricted = loadRules(projectDir, "claude-code");
    const restricted = loadRules(projectDir, "claude-code", { claudeHomes: [homeA] });
    expect(hasGlobal(unrestricted, "marker-home-a")).toBe(true);
    expect(hasGlobal(restricted, "marker-home-a")).toBe(true);
    expect(hasGlobal(unrestricted, "marker-home-b")).toBe(false);
    expect(hasGlobal(restricted, "marker-home-b")).toBe(false);
  });
});
