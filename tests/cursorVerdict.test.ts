import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { evaluateSession } from "../src/evaluate.js";
import { loadRules } from "../src/rules.js";
import { parseCursorTranscript } from "../src/adapters/cursor.js";
import type { CheckResult, Rule } from "../src/types.js";

/**
 * Cursor CLI agent-transcripts, redacted synthetic events in the real shape
 * (verified on a real session, agent v2026.10.01): each line is
 * `{ role, message: { content: [Anthropic blocks] } }`; a tool_use's `input` is
 * a JSON STRING; and user text is wrapped as
 * `<timestamp>…</timestamp><user_query>…</user_query>`. The reader unwraps that,
 * so a confirmed push ("yes") reads as Followed rather than unapproved.
 */
const stub = (r: Rule): CheckResult => ({ ruleId: r.id, ruleTitle: r.title, ruleSource: r.source, status: "UNCLEAR", needsHuman: true, evidence: "" });
const L = (o: unknown) => JSON.stringify(o);
const line = (role: string, ...blocks: unknown[]) => L({ role, message: { content: blocks } });
const text = (t: string) => ({ type: "text", text: t });
const uq = (t: string) => text(`<timestamp>Oct 8, 2026</timestamp>\n<user_query>\n${t}\n</user_query>`);
let n = 0;
const tool = (name: string, input: unknown) => ({ type: "tool_use", id: `t${n++}`, name, input: JSON.stringify(input) });

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(homedir(), ".rr-cur-"));
  mkdirSync(join(dir, ".git"));
  writeFileSync(join(dir, "AGENTS.md"), "- Never push to main without asking me first.\n- Never edit .env.\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("Cursor CLI agent-transcripts", () => {
  it("a push confirmed with a wrapped 'yes' is Followed; .env left alone is not Broken", async () => {
    const f = join(dir, "s.jsonl");
    // Prompt says 'update the remote' (no 'push' word), so the only approval is
    // the wrapped 'yes' after the agent asks — this proves the unwrap + approval.
    writeFileSync(
      f,
      [
        line("user", uq("Add a comment to app.js, then update the remote.")),
        line("assistant", text("I'll skip the .env change per the workspace rules."), tool("StrReplace", { path: join(dir, "app.js"), old_string: "x", new_string: "y" })),
        line("assistant", text("Can I push to main now?")),
        line("user", uq("yes")),
        line("assistant", tool("Shell", { command: "git push origin main" })),
      ].join("\n") + "\n"
    );
    const { results } = await evaluateSession(dir, loadRules(dir, "cursor"), parseCursorTranscript(f), false, stub);
    expect(results.find((r) => /push to main/i.test(r.ruleTitle))?.status).toBe("PASS");
    expect(results.find((r) => /\.env/i.test(r.ruleTitle))?.status).not.toBe("FAIL");
  });

  it("parses the message-wrapped lines, JSON-string input, and tool mapping", () => {
    const f = join(dir, "p.jsonl");
    writeFileSync(
      f,
      [
        line("assistant", tool("StrReplace", { path: join(dir, "app.js"), old_string: "a", new_string: "b" })),
        line("assistant", tool("Shell", { command: "git status" })),
      ].join("\n") + "\n"
    );
    const ev = parseCursorTranscript(f);
    const edit = ev.find((e) => e.kind === "tool_use" && e.toolName === "Edit");
    expect((edit?.input as { file_path: string }).file_path).toBe(join(dir, "app.js"));
    const bash = ev.find((e) => e.kind === "tool_use" && e.toolName === "Bash");
    expect((bash?.input as { command: string }).command).toBe("git status");
  });
});
