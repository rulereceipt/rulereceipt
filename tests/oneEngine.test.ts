import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { evaluateSession } from "../src/evaluate.js";
import { loadRules } from "../src/rules.js";
import { readTranscriptFromFile } from "../src/parsers/transcriptParser.js";

/**
 * `check` and the shared engine (hook, report) must give the same verdicts.
 *
 * Found 2026-09-28: `check` had its own copy of the pipeline. It never ran the
 * approval-gate or attribution checkers, so those rules were missing from its
 * report, and it ignored path scope, so check and the Stop hook disagreed on
 * the same session. This test runs the real CLI and the engine on one fixture
 * and requires identical status per rule.
 */
describe("check uses the same engine as hook and report", () => {
  const dir = mkdtempSync(join(tmpdir(), "rr-one-"));
  mkdirSync(join(dir, ".git"));
  mkdirSync(join(dir, ".claude", "rules"), { recursive: true });
  writeFileSync(join(dir, "CLAUDE.md"), [
    "- Never push without explicit user instruction.",
    "- Never add a `Co-Authored-By: Claude` trailer to git commits.",
    "- Never edit `.env`",
    "- Keep changes small.",
  ].join("\n"));
  writeFileSync(join(dir, ".claude", "rules", "db.md"), '---\npaths: ["db/**"]\n---\n- Never run `git push --force`\n');
  const line = (o: unknown) => JSON.stringify(o);
  const s = join(dir, "s.jsonl");
  writeFileSync(s, [
    line({ type: "user", timestamp: "2026-09-28T00:00:00Z", permissionMode: "bypassPermissions", message: { role: "user", content: "fix the web page" } }),
    line({ type: "assistant", timestamp: "2026-09-28T00:00:01Z", message: { role: "assistant", content: [{ type: "tool_use", id: "a", name: "Edit", input: { file_path: join(dir, "web/a.ts"), old_string: "a", new_string: "b" } }] } }),
    line({ type: "user", timestamp: "2026-09-28T00:00:02Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "ok" }] } }),
    line({ type: "assistant", timestamp: "2026-09-28T00:00:03Z", message: { role: "assistant", content: [{ type: "tool_use", id: "b", name: "Bash", input: { command: "git commit -m 'x\n\nCo-Authored-By: Claude <noreply@anthropic.com>' && git push --force" } }] } }),
    line({ type: "user", timestamp: "2026-09-28T00:00:04Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "b", content: "ok" }] } }),
  ].join("\n"));

  it("gives identical statuses per rule", async () => {
    const env = { ...process.env, HOME: mkdtempSync(join(tmpdir(), "rr-home-")) };
    const out = execFileSync("node", [join(process.cwd(), "dist", "cli.js"), "check", "--transcript", s, "--json", "--exit-zero"], { cwd: dir, env, encoding: "utf-8" });
    const cli = JSON.parse(out) as { results?: Array<{ ruleTitle: string; status: string }> };
    const prevHome = process.env.HOME;
    process.env.HOME = env.HOME;
    const { results } = await evaluateSession(dir, loadRules(dir), readTranscriptFromFile(s), false, (r) => ({ ruleId: r.id, ruleTitle: r.title, ruleSource: r.source, status: "UNCLEAR", needsHuman: true, evidence: "" }));
    process.env.HOME = prevHome;
    const byTitle = (rs: Array<{ ruleTitle: string; status: string }>) => Object.fromEntries(rs.map((r) => [r.ruleTitle, r.status]));
    expect(byTitle(cli.results ?? [])).toEqual(byTitle(results));
    // and the two rules that used to vanish from `check` are present
    expect(Object.keys(byTitle(cli.results ?? []))).toEqual(expect.arrayContaining([
      "Never push without explicit user instruction.",
      "Never add a `Co-Authored-By: Claude` trailer to git commits.",
    ]));
  });
});
