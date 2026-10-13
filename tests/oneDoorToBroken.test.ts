import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { runGitBranchPolicyChecks } from "../src/checks/gitBranchPolicy.js";
import { runCodeContentChecks } from "../src/checks/codeContent.js";
import { runFileLifecycleChecks } from "../src/checks/fileLifecycle.js";
import type { GitBranchPolicyClassification } from "../src/checks/classify.js";
import type { CodeContentClassification } from "../src/checks/classify.js";
import type { FileLifecycleClassification } from "../src/checks/classify.js";
import type { TranscriptEvent } from "../src/types.js";

/**
 * "One door to Broken": a FAIL verdict may only be constructed in a tightly
 * controlled set of places. Two guards, one structural and one behavioural.
 *
 * 1. STRUCTURAL: the literal `status: "FAIL"` (constructing a Broken verdict,
 *    as opposed to a `=== "FAIL"` comparison) appears ONLY in the sanctioned
 *    files. types.ts holds violation() — the single forbid→FAIL constructor,
 *    which is compile-time-gated to a "forbid" polarity so a require rule
 *    cannot accuse. claimEvidence.ts holds the contradiction-FAIL (a claim
 *    the log disproves). cli.ts holds the hardcoded DEMO results. A new FAIL
 *    path anywhere else fails this test — the day inspection stops holding.
 *
 * 2. BEHAVIOURAL: a require-polarity rule NEVER yields FAIL, whatever the
 *    session did — absence of a required action is UNCLEAR, presence is PASS,
 *    neither is an accusation. And every FAIL that IS produced carries evidence.
 */

const ROOT = process.cwd();
const FAIL_CONSTRUCTION = /status:\s*"FAIL"/;
const ALLOW = new Set(["src/types.ts", "src/checks/claimEvidence.ts", "src/cli.ts"]);

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("one-door-to-broken: structural", () => {
  const files = tsFiles(join(ROOT, "src"));
  const withConstruction = files
    .filter((f) => readFileSync(f, "utf-8").split("\n").some((l) => FAIL_CONSTRUCTION.test(l)))
    .map((f) => relative(ROOT, f).replace(/\\/g, "/"));

  it("`status: \"FAIL\"` is constructed ONLY in the sanctioned files", () => {
    const unexpected = withConstruction.filter((f) => !ALLOW.has(f));
    expect(unexpected, `new FAIL construction outside the allow-list: ${unexpected.join(", ")}`).toEqual([]);
  });
  it("each sanctioned file still contains it (the pattern did not silently move/rename)", () => {
    for (const f of ALLOW) expect(withConstruction, `${f} no longer constructs a FAIL`).toContain(f);
  });
});

// --- behavioural: require-polarity never FAILs ---
const bash = (command: string): TranscriptEvent => ({ role: "assistant", kind: "tool_use", toolName: "Bash", input: { command }, timestamp: "t" });
const write = (file_path: string, content = "x"): TranscriptEvent => ({ role: "assistant", kind: "tool_use", toolName: "Write", input: { file_path, content }, timestamp: "t" });
const rule = (id: string) => ({ id, title: "t", text: "t", source: "project" as const });

const gitReq: GitBranchPolicyClassification = { kind: "gitBranchPolicy", rule: rule("1"), branchName: "main", polarity: "require" };
const codeReq: CodeContentClassification = { kind: "codeContent", rule: rule("2"), patterns: ["track("], polarity: "require" };
const fileReq: FileLifecycleClassification = { kind: "fileLifecycle", rule: rule("3"), filePath: "CHANGELOG.md", polarity: "require" };

describe("one-door-to-broken: a require rule can never produce FAIL", () => {
  it("gitBranchPolicy require: required action absent (pushed a DIFFERENT branch) → not FAIL", () => {
    expect(runGitBranchPolicyChecks([gitReq], [bash("git push origin dev")])[0].status).not.toBe("FAIL");
  });
  it("gitBranchPolicy require: required action present → PASS, not FAIL", () => {
    expect(runGitBranchPolicyChecks([gitReq], [bash("git push origin main")])[0].status).not.toBe("FAIL");
  });
  it("codeContent require: required pattern absent → not FAIL", () => {
    expect(runCodeContentChecks([codeReq], [write("a.ts", "const x = 1;")])[0].status).not.toBe("FAIL");
  });
  it("codeContent require: required pattern present → PASS, not FAIL", () => {
    expect(runCodeContentChecks([codeReq], [write("a.ts", "analytics.track(e)")])[0].status).not.toBe("FAIL");
  });
  it("fileLifecycle require: required file never touched → not FAIL", () => {
    expect(runFileLifecycleChecks([fileReq], [bash("echo hi")])[0].status).not.toBe("FAIL");
  });
  it("fileLifecycle require: required file updated → PASS, not FAIL", () => {
    expect(runFileLifecycleChecks([fileReq], [write("CHANGELOG.md")])[0].status).not.toBe("FAIL");
  });
});

describe("one-door-to-broken: every FAIL carries evidence", () => {
  const gitForbid: GitBranchPolicyClassification = { kind: "gitBranchPolicy", rule: rule("4"), branchName: "main", polarity: "forbid" };
  const codeForbid: CodeContentClassification = { kind: "codeContent", rule: rule("5"), patterns: ["track("], polarity: "forbid" };
  const fileForbid: FileLifecycleClassification = { kind: "fileLifecycle", rule: rule("6"), filePath: "CHANGELOG.md", polarity: "forbid" };
  it("a forbid FAIL from each checker has non-empty evidence", () => {
    const fails = [
      runGitBranchPolicyChecks([gitForbid], [bash("git push origin main")])[0],
      runCodeContentChecks([codeForbid], [write("a.ts", "analytics.track(e)")])[0],
      runFileLifecycleChecks([fileForbid], [write("CHANGELOG.md")])[0],
    ];
    for (const f of fails) {
      expect(f.status).toBe("FAIL");
      expect(f.evidence.trim().length, `${f.ruleId} FAIL with empty evidence`).toBeGreaterThan(0);
    }
  });
});
