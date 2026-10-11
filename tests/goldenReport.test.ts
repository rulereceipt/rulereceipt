import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateSession } from "../src/evaluate.js";
import type { Rule, TranscriptEvent, CheckResult } from "../src/types.js";

/**
 * Golden verdict snapshot (correctness-program): a fixed session + rules whose
 * exact verdicts and evidence are locked here. Any change to a checker that
 * alters what this well-understood input produces breaks this test loudly, so
 * the change has to be a deliberate edit to the golden — not a silent drift.
 * The results array (not the rendered report) is golden'd on purpose: it is
 * deterministic, where the rendered report carries a timestamp and a session
 * hash.
 */
function bash(command: string): TranscriptEvent {
  return { role: "assistant", kind: "tool_use", toolName: "Bash", input: { command }, timestamp: "2026-10-11T00:00:00Z" };
}
const llmStub = (r: Rule): CheckResult => ({ ruleId: r.id, ruleTitle: r.title, ruleSource: r.source, status: "UNCLEAR", evidence: "llm-stub" });

const RULES: Rule[] = [
  { id: "1", title: "No direct push to main", text: "Never push to the `main` branch.", source: "project" },
  { id: "2", title: "Require tests before commit", text: "Always run `npm test` before you `git commit`.", source: "project" },
];
const EVENTS: TranscriptEvent[] = [bash("git fetch origin"), bash("git push origin main")];

// The locked golden. Update ONLY with an intentional, explained change.
const GOLDEN = [
  {
    ruleId: "1",
    status: "FAIL",
    outcome: "fail",
    evidence: 'a git command actually targeted the "main" branch: git push origin main',
  },
  {
    ruleId: "2",
    status: "UNCLEAR",
    outcome: null,
    evidence:
      'required pattern "npm test" or "git commit" was not actually run this session — can\'t tell if the rule didn\'t apply, or applied and was skipped',
  },
];

let cwd: string;
beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), "rr-golden-")); });
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe("golden verdict snapshot for a fixed session + rules", () => {
  it("produces exactly the locked verdicts and evidence", async () => {
    const { results } = await evaluateSession(cwd, RULES, EVENTS, false, llmStub);
    const normalized = results
      .map((r) => ({ ruleId: r.ruleId, status: r.status, outcome: r.outcome ?? null, evidence: r.evidence }))
      .sort((a, b) => a.ruleId.localeCompare(b.ruleId));
    expect(normalized).toEqual(GOLDEN);
  });
});
