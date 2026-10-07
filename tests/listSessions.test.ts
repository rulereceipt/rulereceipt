import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSessionRows, renderSessionList } from "../src/listSessions.js";
import { claudeCodeAdapter } from "../src/adapters/index.js";

function sess(dir: string, name: string, firstUser: string): string {
  const p = join(dir, name);
  writeFileSync(p, [
    JSON.stringify({ type: "user", timestamp: "t", message: { role: "user", content: firstUser } }),
    JSON.stringify({ type: "assistant", timestamp: "t", message: { role: "assistant", content: [{ type: "tool_use", id: "a", name: "Bash", input: { command: "ls" } }] } }),
  ].join("\n"));
  return p;
}

describe("check --list-sessions", () => {
  const dir = mkdtempSync(join(tmpdir(), "rr-ls-"));
  const a = sess(dir, "a.jsonl", "fix the login page please");
  const b = sess(dir, "b.jsonl", "deploy with token sk" + "-abcdefghijklmnop1234 now");
  const sessions = [
    { adapter: claudeCodeAdapter, file: a },
    { adapter: claudeCodeAdapter, file: b },
  ];

  it("lists each session's tool and first prompt", () => {
    const rows = listSessionRows(dir, 15, sessions);
    expect(rows).toHaveLength(2);
    expect(rows[0].tool).toBe("claude-code");
    expect(rows[0].firstPrompt).toBe("fix the login page please");
  });

  it("redacts secrets in the shown prompt", () => {
    const rows = listSessionRows(dir, 15, sessions);
    expect(rows[1].firstPrompt).not.toContain(("sk" + "-abcdefghijklmnop1234"));
    expect(rows[1].firstPrompt).toMatch(/<redacted/);
  });

  it("renders paths to pass to --transcript, and a helpful empty message", () => {
    const out = renderSessionList(listSessionRows(dir, 15, sessions), dir);
    expect(out).toContain("--transcript");
    expect(out).toContain("a.jsonl");
    expect(renderSessionList([], dir)).toContain("No coding-agent sessions found");
  });
});
