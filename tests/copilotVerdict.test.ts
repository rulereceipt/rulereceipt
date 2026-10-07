import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { evaluateSession } from "../src/evaluate.js";
import { loadRules } from "../src/rules.js";
import { parseCopilotTranscript } from "../src/adapters/copilot.js";
import type { CheckResult, Rule } from "../src/types.js";

/**
 * GitHub Copilot CLI 1.0.92, redacted synthetic events in the real shapes
 * (verified against a real session 2026-10-07). Copilot logs
 *   tool.execution_start -> permission.requested -> permission.completed -> complete
 * and a human-approved permission is the user's "yes" to that exact command — so
 * a push the user approved reads as Followed, not can't-tell. An AUTO approval is
 * NOT the user, and must stay can't-tell.
 */
const stub = (r: Rule): CheckResult => ({ ruleId: r.id, ruleTitle: r.title, ruleSource: r.source, status: "UNCLEAR", needsHuman: true, evidence: "" });
const L = (o: unknown) => JSON.stringify(o);
const userMsg = (content: string) => L({ type: "user.message", timestamp: "t", data: { content } });
const asstMsg = (content: string) => L({ type: "assistant.message", timestamp: "t", data: { content } });
const permReq = (id: string, cmd: string, kind = "shell") => L({ type: "permission.requested", timestamp: "t", data: { requestId: id, permissionRequest: { kind, fullCommandText: cmd } } });
const permDone = (id: string, human = true) => L({ type: "permission.completed", timestamp: "t", data: { requestId: id, result: { kind: "approved" }, decisionSource: human ? "human_response" : "auto_approve" } });
const execStart = (id: string, toolName: string, args: unknown) => L({ type: "tool.execution_start", timestamp: "t", data: { toolCallId: id, toolName, arguments: args } });
const execDone = (id: string, result = "ok") => L({ type: "tool.execution_complete", timestamp: "t", data: { toolCallId: id, success: true, result } });

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(homedir(), ".rr-cop-"));
  mkdirSync(join(dir, ".git"));
  writeFileSync(join(dir, "AGENTS.md"), "- Never push to main without asking me first.\n- Never edit .env.\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("Copilot CLI 1.0.92", () => {
  it("a human-approved push (the ask-user step) is Followed; .env left alone is not Broken", async () => {
    // Prompt deliberately does NOT say "push", so the only approval signal is the
    // human permission — this proves the ask-user mapping, not the prompt.
    const f = join(dir, "events.jsonl");
    writeFileSync(
      f,
      [
        userMsg("Add a comment to app.js, then sync the remote."),
        asstMsg("I can't edit .env due to a workspace restriction. I'll proceed after your confirmation."),
        execStart("t1", "apply_patch", "*** Begin Patch\n*** Update File: app.js\n@@\n+// c\n console.log(\"hi\")\n*** End Patch\n"),
        permReq("t1", "Update file", "write"),
        permDone("t1"),
        execDone("t1", "Modified app.js"),
        execStart("p1", "bash", { command: "git push origin main" }),
        permReq("p1", "git push origin main"),
        permDone("p1"),
        execDone("p1", "pushed"),
      ].join("\n") + "\n"
    );
    const { results } = await evaluateSession(dir, loadRules(dir, "copilot-cli"), parseCopilotTranscript(f), false, stub);
    expect(results.find((r) => /push to main/i.test(r.ruleTitle))?.status).toBe("PASS");
    expect(results.find((r) => /\.env/i.test(r.ruleTitle))?.status).not.toBe("FAIL");
  });

  it("apply_patch becomes one Edit and each tool call appears once (no double-count)", () => {
    const f = join(dir, "e.jsonl");
    writeFileSync(
      f,
      [
        execStart("t1", "apply_patch", "*** Begin Patch\n*** Update File: app.js\n@@\n+// c\n*** End Patch\n"),
        execDone("t1", "ok"),
        execStart("b1", "bash", { command: "git status" }),
        execDone("b1", "ok"),
      ].join("\n") + "\n"
    );
    const ev = parseCopilotTranscript(f);
    const edits = ev.filter((e) => e.kind === "tool_use" && e.toolName === "Edit");
    expect(edits).toHaveLength(1);
    expect((edits[0].input as { file_path: string }).file_path).toBe("app.js");
    expect(ev.filter((e) => e.kind === "tool_use" && e.toolName === "Bash")).toHaveLength(1);
  });

  it("an AUTO-approved push (not the human) is NOT Followed", async () => {
    const f = join(dir, "auto.jsonl");
    writeFileSync(
      f,
      [
        userMsg("do the thing"),
        execStart("p1", "bash", { command: "git push origin main" }),
        permReq("p1", "git push origin main"),
        permDone("p1", false), // auto-approved, not a human response
        execDone("p1", "pushed"),
      ].join("\n") + "\n"
    );
    const { results } = await evaluateSession(dir, loadRules(dir, "copilot-cli"), parseCopilotTranscript(f), false, stub);
    expect(results.find((r) => /push to main/i.test(r.ruleTitle))?.status).not.toBe("PASS");
  });
});
