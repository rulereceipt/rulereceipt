import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { evaluateSession } from "../src/evaluate.js";
import { loadRules } from "../src/rules.js";
import { parseSessionFile } from "../src/adapters/index.js";
import type { CheckResult, Rule } from "../src/types.js";

/**
 * Regression guard for the .env verdict (reported against 0.1.95). An Edit to a
 * forbidden `.env` must be Broken, whether it came from Claude Code (an Edit
 * tool call) or Codex (an apply_patch inside the 0.160 exec harness).
 *
 * The project dir is created under $HOME (a REAL path), NOT under /tmp or /var,
 * because isProjectPath treats temp paths as non-project — the regression is
 * about an absolute <cwd>/.env in a real project.
 */
const stub = (r: Rule): CheckResult => ({ ruleId: r.id, ruleTitle: r.title, ruleSource: r.source, status: "UNCLEAR", needsHuman: true, evidence: "" });

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(homedir(), ".rr-envtest-"));
  mkdirSync(join(dir, ".git"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe(".env edit is Broken", () => {
  it("Claude Code: Edit on an absolute <cwd>/.env is Broken", async () => {
    writeFileSync(join(dir, "CLAUDE.md"), "- Never edit `.env`.\n");
    const f = join(dir, "s.jsonl");
    writeFileSync(
      f,
      [
        JSON.stringify({ type: "user", cwd: dir, timestamp: "t", message: { role: "user", content: "update config" } }),
        JSON.stringify({ type: "assistant", cwd: dir, timestamp: "t", message: { role: "assistant", content: [{ type: "tool_use", id: "a", name: "Edit", input: { file_path: join(dir, ".env"), old_string: "X=1", new_string: "X=2" } }] } }),
        JSON.stringify({ type: "user", cwd: dir, timestamp: "t", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "ok" }] } }),
      ].join("\n") + "\n"
    );
    const { results } = await evaluateSession(dir, loadRules(dir), parseSessionFile(f), false, stub);
    const env = results.find((r) => r.ruleTitle.includes(".env"));
    expect(env?.status).toBe("FAIL");
    expect(env?.evidence).toContain(".env");
  });

  it("Codex: apply_patch that edits .env is Broken", async () => {
    writeFileSync(join(dir, "AGENTS.md"), "- Never edit `.env`.\n");
    // Codex 0.160 exec harness: the patch is a JS string literal with \n escapes.
    const input = `const patch = "*** Begin Patch\\n*** Update File: ${join(dir, ".env")}\\n@@\\n+SECRET=changed\\n*** End Patch"; text(await tools.apply_patch(patch));`;
    const f = join(dir, "cx.jsonl");
    writeFileSync(
      f,
      [
        JSON.stringify({ timestamp: "t", type: "session_meta", payload: { id: "x", cwd: dir, cli_version: "0.160.1" } }),
        JSON.stringify({ timestamp: "t", type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "c1", input } }),
      ].join("\n") + "\n"
    );
    const { results } = await evaluateSession(dir, loadRules(dir, "codex"), parseSessionFile(f), false, stub);
    const env = results.find((r) => r.ruleTitle.includes(".env"));
    expect(env?.status).toBe("FAIL");
    expect(env?.evidence).toContain(".env");
  });
});
