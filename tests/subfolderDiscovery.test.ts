import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRules, describeRuleSources } from "../src/rules.js";
import { evaluateSession } from "../src/evaluate.js";
import type { CheckResult, Rule, TranscriptEvent } from "../src/types.js";

/**
 * Subfolder CLAUDE.md/AGENTS.md discovery.
 *
 * Claude Code loads a subfolder rules file the moment the session touches a
 * file in that subtree (a `nested_memory` attachment in the transcript). The
 * up-only walk never saw these: running `check` from a parent workspace missed
 * every subfolder rules file. Proven 2026-10-03 against real nested_memory
 * ground truth — with cwd at the workspace root, the agent had loaded
 * `costrr/CLAUDE.md` and `Daily _crypto/CLAUDE.md`, neither of which the tool
 * discovered.
 *
 * The fixture reproduces that shape, redacted: a parent workspace whose cwd has
 * its own CLAUDE.md, plus a subfolder `pkg/` with its own CLAUDE.md naming a
 * branch rule — exactly the structure of the real sessions.
 *
 * Safety is the whole point: a subfolder rule is scoped to its subtree, so it
 * is applied ONLY to a session that worked there. A session that never touched
 * the subtree reports not_applicable, never Broken — no false accusation.
 */
let dir: string, home: string, prevHome: string | undefined, prevCfg: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rr-sub-"));
  home = mkdtempSync(join(tmpdir(), "rr-sub-home-"));
  prevHome = process.env.HOME; prevCfg = process.env.CLAUDE_CONFIG_DIR;
  process.env.HOME = home; process.env.USERPROFILE = home; delete process.env.CLAUDE_CONFIG_DIR;
  // Parent workspace rule + a subfolder rule (the real shape).
  writeFileSync(join(dir, "CLAUDE.md"), "## Root\n- Keep the workspace tidy.\n");
  mkdirSync(join(dir, "pkg"), { recursive: true });
  writeFileSync(join(dir, "pkg", "CLAUDE.md"), "## No pushing to main from pkg\nNever push to the `main` branch directly.\n");
});
afterEach(() => {
  process.env.HOME = prevHome;
  if (prevCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prevCfg;
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const needsLlm = (r: Rule): CheckResult => ({ ruleId: r.id, ruleTitle: r.title, ruleSource: r.source, status: "UNCLEAR", needsHuman: true, evidence: "" });
let clock = 0;
const bash = (command: string): TranscriptEvent => ({ role: "assistant", kind: "tool_use", toolName: "Bash", input: { command }, timestamp: `t${clock++}` });
const edit = (file_path: string): TranscriptEvent => ({ role: "assistant", kind: "tool_use", toolName: "Edit", input: { file_path }, timestamp: `t${clock++}` });

describe("subfolder rules discovery (nested_memory ground truth)", () => {
  it("discovers a subfolder CLAUDE.md the up-walk would miss", () => {
    const rules = loadRules(dir);
    const sub = rules.find((r) => /No pushing to main from pkg/i.test(r.title));
    expect(sub, "subfolder branch rule should be loaded").toBeTruthy();
  });

  it("scopes the subfolder rule to its subtree (paths = pkg/**)", () => {
    const rules = loadRules(dir);
    const sub = rules.find((r) => /No pushing to main from pkg/i.test(r.title))!;
    expect(sub.paths).toEqual(["pkg/**"]);
  });

  it("lists the subfolder file in the load graph with a conditional note", () => {
    const graph = describeRuleSources(dir);
    const sub = graph.find((g) => g.path === join(dir, "pkg", "CLAUDE.md"));
    expect(sub?.status).toBe("loaded");
    expect(sub?.note).toMatch(/loaded when the agent works in pkg\//);
  });

  it("APPLIES the subfolder rule when the session worked in the subtree (Broken)", async () => {
    const rules = loadRules(dir);
    const events = [edit(join(dir, "pkg", "api.ts")), bash("git push origin main")];
    const { results } = await evaluateSession(dir, rules, events, false, needsLlm);
    const sub = results.find((r) => /No pushing to main from pkg/i.test(r.ruleTitle))!;
    expect(sub.status).toBe("FAIL");
  });

  it("does NOT apply the subfolder rule when the session never touched the subtree (no false accusation)", async () => {
    const rules = loadRules(dir);
    // Pushes to main, but only ever edited a file OUTSIDE pkg/ — the agent would
    // never have loaded pkg/CLAUDE.md, so checking against it would be unfair.
    const events = [edit(join(dir, "README.md")), bash("git push origin main")];
    const { results } = await evaluateSession(dir, rules, events, false, needsLlm);
    const sub = results.find((r) => /No pushing to main from pkg/i.test(r.ruleTitle))!;
    expect(sub.status).not.toBe("FAIL");
    expect(sub.outcome).toBe("not_applicable");
  });
});
