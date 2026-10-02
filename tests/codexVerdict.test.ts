import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSessionFile } from "../src/adapters/index.js";
import { evaluateSession } from "../src/evaluate.js";
import { loadRules } from "../src/rules.js";
import type { CheckResult, Rule } from "../src/types.js";

/**
 * The "supported" bar for an adapter: a planted violation it MUST catch and a
 * clean session it must stay quiet on — run through the SAME engine as Claude
 * Code, so Codex gets the same verdict quality. This is what lets the site call
 * Codex supported rather than "in testing".
 *
 * HOME is isolated so the machine's own global rules can't change the verdict.
 */
let dir: string, home: string, prevHome: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rr-codexv-"));
  home = mkdtempSync(join(tmpdir(), "rr-codexv-home-"));
  prevHome = process.env.HOME; process.env.HOME = home; process.env.USERPROFILE = home;
  writeFileSync(join(dir, "CLAUDE.md"), "## 1. Branch\nNever push to the `main` branch directly.\n");
});
afterEach(() => {
  process.env.HOME = prevHome;
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const meta = (cwd: string) => JSON.stringify({ timestamp: "t", type: "session_meta", payload: { id: "1", cwd } });
const shell = (cmd: string) => JSON.stringify({ timestamp: "2026-03-31T22:18:46Z", type: "response_item", payload: { type: "local_shell_call", action: { command: ["bash", "-lc", cmd] }, call_id: "c1" } });

const stub = (r: Rule): CheckResult => ({ ruleId: r.id, ruleTitle: r.title, ruleSource: r.source, status: "UNCLEAR", needsHuman: true, evidence: "" });

describe("Codex adapter — same verdict quality as Claude Code (supported bar)", () => {
  it("planted violation: a Codex session that pushes to main is reported Broken", async () => {
    const f = join(dir, "rollout-fail.jsonl");
    writeFileSync(f, [meta(dir), shell("git push origin main")].join("\n") + "\n");
    const { results } = await evaluateSession(dir, loadRules(dir), parseSessionFile(f), false, stub);
    const branch = results.find((r) => r.ruleTitle.toLowerCase().includes("branch"));
    expect(branch?.status).toBe("FAIL");
    expect(branch?.evidence).toContain("git push origin main");
  });

  it("clean session: a Codex session that only runs tests is NOT reported Broken", async () => {
    const f = join(dir, "rollout-clean.jsonl");
    writeFileSync(f, [meta(dir), shell("npm test")].join("\n") + "\n");
    const { results } = await evaluateSession(dir, loadRules(dir), parseSessionFile(f), false, stub);
    expect(results.some((r) => r.status === "FAIL")).toBe(false);
  });
});
