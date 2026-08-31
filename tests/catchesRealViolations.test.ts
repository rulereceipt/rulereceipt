import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseClaudeMd } from "../src/parsers/claudeMdParser.js";
import { readTranscriptFromFile } from "../src/parsers/transcriptParser.js";
import { classifyRules } from "../src/checks/classify.js";
import { runDeterministicChecks } from "../src/checks/deterministicChecks.js";
import { runIfEditThenTestChecks } from "../src/checks/ifEditThenTest.js";
import { runGitBranchPolicyChecks } from "../src/checks/gitBranchPolicy.js";
import { runCodeContentChecks } from "../src/checks/codeContent.js";
import { runFileLifecycleChecks } from "../src/checks/fileLifecycle.js";
import type { CheckResult } from "../src/types.js";

/**
 * Does it actually CATCH a violation — not merely avoid false alarms?
 *
 * Every other suite here proves the tool doesn't wrongly flag compliant
 * sessions, which was the real bug found on 2026-08-30. That leaves the
 * opposite question untested end to end: given a session that genuinely
 * breaks a stated rule, does the real pipeline report it?
 *
 * These build a real rules file and a real transcript on disk, in the
 * actual Claude Code JSONL format, and run the same parse -> classify ->
 * check path the CLI runs. A tool that can't be shown catching a real
 * violation isn't proven by a green suite of "no false positives".
 */

let dir: string;
let rulesPath: string;

function transcript(events: object[]): string {
  const p = join(dir, `session-${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(p, events.map((e) => JSON.stringify(e)).join("\n"));
  return p;
}

function bashCall(command: string) {
  return {
    type: "assistant",
    timestamp: "2026-08-31T00:00:00Z",
    message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command } }] },
  };
}

function writeCall(file_path: string, content: string) {
  return {
    type: "assistant",
    timestamp: "2026-08-31T00:00:00Z",
    message: { content: [{ type: "tool_use", id: "t2", name: "Write", input: { file_path, content } }] },
  };
}

/** Runs the real pipeline, exactly as `rulereceipt check` does. */
function check(transcriptPath: string): CheckResult[] {
  const rules = parseClaudeMd(rulesPath, "project");
  const events = readTranscriptFromFile(transcriptPath);
  const c = classifyRules(rules);
  return [
    ...runDeterministicChecks(c.filter((x) => x.kind === "deterministic"), events),
    ...runIfEditThenTestChecks(c.filter((x) => x.kind === "ifEditThenTest"), events),
    ...runGitBranchPolicyChecks(c.filter((x) => x.kind === "gitBranchPolicy"), events),
    ...runCodeContentChecks(c.filter((x) => x.kind === "codeContent"), events),
    ...runFileLifecycleChecks(c.filter((x) => x.kind === "fileLifecycle"), events),
  ];
}

function resultFor(results: CheckResult[], titleFragment: string): CheckResult {
  const r = results.find((x) => x.ruleTitle.toLowerCase().includes(titleFragment.toLowerCase()));
  if (!r) throw new Error(`no result for rule matching "${titleFragment}" — got: ${results.map((x) => x.ruleTitle).join(" | ")}`);
  return r;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "rulereceipt-e2e-"));
  rulesPath = join(dir, "CLAUDE.md");
  writeFileSync(
    rulesPath,
    [
      "## Protected branch",
      "Never commit directly to the `main` branch.",
      "",
      "## No debug prints",
      "Never leave a `console.log(` call in committed code.",
      "",
      "## Protected config",
      "Never modify `.claude/settings.json`.",
      "",
    ].join("\n")
  );
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("catches real violations end to end", () => {
  it("CATCHES committing directly to a protected branch", () => {
    const t = transcript([bashCall("git checkout main"), bashCall("git commit -am 'hotfix straight to main'")]);
    const r = resultFor(check(t), "Protected branch");
    expect(r.status).toBe("FAIL");
    expect(r.evidence).toContain("main");
  });

  it("CATCHES a debug call actually written into a file", () => {
    const t = transcript([writeCall("src/pay.ts", "function pay() {\n  console.log('amount', amt);\n}")]);
    const r = resultFor(check(t), "No debug prints");
    expect(r.status).toBe("FAIL");
    expect(r.evidence).toContain("console.log(");
  });

  it("CATCHES a protected file being deleted", () => {
    const t = transcript([bashCall("rm .claude/settings.json")]);
    const r = resultFor(check(t), "Protected config");
    expect(r.status).toBe("FAIL");
  });

  it("CATCHES a protected file being overwritten", () => {
    const t = transcript([writeCall(".claude/settings.json", "{}")]);
    const r = resultFor(check(t), "Protected config");
    expect(r.status).toBe("FAIL");
  });

  it("catches multiple violations in one session, independently", () => {
    const t = transcript([
      bashCall("git checkout main"),
      bashCall("git commit -am wip"),
      writeCall("src/a.ts", "console.log('x')"),
      bashCall("rm .claude/settings.json"),
    ]);
    const results = check(t);
    expect(resultFor(results, "Protected branch").status).toBe("FAIL");
    expect(resultFor(results, "No debug prints").status).toBe("FAIL");
    expect(resultFor(results, "Protected config").status).toBe("FAIL");
  });

  // The other half of the claim: a compliant session must NOT be flagged,
  // including the near-miss shapes that caused the real false positives.
  it("does NOT flag a compliant session that merely mentions the same things", () => {
    const t = transcript([
      bashCall("git checkout main && git pull origin main"), // synced, never committed
      bashCall("git checkout -b feature/x"),
      bashCall("git commit -am 'real work on a feature branch'"),
      bashCall("cat .claude/settings.json"), // read, not modified
      bashCall("grep -rn 'console.log(' src/"), // searched for, not written
      writeCall("src/clean.ts", "export const x = 1;"),
    ]);
    const results = check(t);
    expect(resultFor(results, "Protected branch").status).not.toBe("FAIL");
    expect(resultFor(results, "No debug prints").status).not.toBe("FAIL");
    expect(resultFor(results, "Protected config").status).not.toBe("FAIL");
  });
});
