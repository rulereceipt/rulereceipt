import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeSessions, renderNoRules, draftRulesFromHistory } from "../src/sessionObserve.js";
import { claudeCodeAdapter } from "../src/adapters/index.js";

function sessionFile(dir: string, name: string, lines: unknown[]): string {
  const p = join(dir, name);
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n"));
  return p;
}

describe("session observation (no rules needed)", () => {
  const dir = mkdtempSync(join(tmpdir(), "rr-obs-"));
  const s1 = sessionFile(dir, "s1.jsonl", [
    { type: "assistant", timestamp: "t", message: { role: "assistant", content: [{ type: "tool_use", id: "a", name: "Bash", input: { command: "git push origin main" } }] } },
    { type: "assistant", timestamp: "t", message: { role: "assistant", content: [{ type: "tool_use", id: "b", name: "Edit", input: { file_path: join(dir, ".env"), old_string: "a", new_string: "b" } }] } },
    { type: "assistant", timestamp: "t", message: { role: "assistant", content: [{ type: "text", text: "All tests pass, done." }] } },
  ]);
  const s2 = sessionFile(dir, "s2.jsonl", [
    { type: "assistant", timestamp: "t", message: { role: "assistant", content: [{ type: "tool_use", id: "c", name: "Bash", input: { command: "npm test" } }] } },
    { type: "assistant", timestamp: "t", message: { role: "assistant", content: [{ type: "text", text: "the tests pass now" }] } },
  ]);
  const sessions = [
    { adapter: claudeCodeAdapter, file: s1 },
    { adapter: claudeCodeAdapter, file: s2 },
  ];

  it("counts pushes, .env writes and test-pass claims (and which had no test run)", () => {
    const o = observeSessions(dir, 30, Date.now(), sessions);
    expect(o.sessions).toBe(2);
    expect(o.pushes).toBe(1);
    expect(o.envWrites).toBe(1);
    expect(o.testClaims).toBe(2); // s1 "all tests pass" + s2 "tests pass now"
    expect(o.testClaimsNoRun).toBe(1); // only s1 ran no test command; s2 ran `npm test`
  });

  it("drafts a rule only for things that actually happened", () => {
    const o = observeSessions(dir, 30, Date.now(), sessions);
    const draft = draftRulesFromHistory(o);
    expect(draft).toContain("Never push without asking");
    expect(draft).toContain("Never edit `.env`");
    expect(draft).toContain("Don't say the tests pass without running them");
    expect(draft).not.toContain("Ask before committing"); // no commits observed
  });

  it("renders what the agent did, framed as observations not verdicts", () => {
    const out = renderNoRules(observeSessions(dir, 30, Date.now(), sessions), "my-app");
    expect(out).toContain("pushed 1 time");
    expect(out).toContain("wrote to a .env file 1 time");
    expect(out).toContain("init --from-history");
    expect(out).not.toMatch(/broke|FAIL|violat/i); // nothing accused — there are no rules
  });
});
