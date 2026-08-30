import { describe, it, expect } from "vitest";
import { runDeterministicChecks } from "../src/checks/deterministicChecks.js";
import type { DeterministicClassification } from "../src/checks/classify.js";
import type { TranscriptEvent } from "../src/types.js";

function toolUse(toolName: string, input: unknown): TranscriptEvent {
  return { role: "assistant", kind: "tool_use", toolName, input, timestamp: "2026-08-16T00:00:00Z" };
}

function toolResult(content: string): TranscriptEvent {
  return { role: "user", kind: "tool_result", content, isError: false, timestamp: "2026-08-16T00:00:00Z" };
}

const rule: DeterministicClassification = {
  kind: "deterministic",
  rule: { id: "5", title: "No force push", text: "Never run `git push --force`.", source: "project" },
  patterns: ["git push --force"],
  polarity: "forbid",
};

describe("runDeterministicChecks", () => {
  // The permanent guarantee, not a per-case fix: no bare text match may
  // ever produce a confident FAIL, for any rule, in any format. A match
  // proves a string appeared; it cannot distinguish the agent DOING the
  // forbidden thing from grepping for it, quoting it, or naming it in a
  // commit message. Independent testing on a real session found 19 of 19
  // remaining FAILs were exactly that confusion — repo and branch names
  // in ordinary conversation and inside legitimate git commands.
  // Confident FAILs come only from structured primitives that read what
  // was actually executed or written. If this test ever fails, the
  // false-positive class has been reintroduced.
  it("NEVER returns FAIL from a text match, whatever the pattern or event kind", () => {
    const patterns = ["git push --force", "sprint", "acme-core-app", "print(", "http://"];
    const events: TranscriptEvent[] = [
      toolUse("Bash", { command: "git push --force origin sprint" }),
      toolUse("Write", { file_path: "a.py", content: "print('x') // http://x.com" }),
      toolUse("Bash", { command: "git clone acme-core-app" }),
      { role: "assistant", kind: "text", text: "I will not run git push --force on sprint", timestamp: "t" },
    ];
    for (const p of patterns) {
      const r: DeterministicClassification = {
        kind: "deterministic",
        rule: { id: "x", title: "t", text: `Never use \`${p}\`.`, source: "project" },
        patterns: [p],
        polarity: "forbid",
      };
      const [result] = runDeterministicChecks([r], events);
      expect(result.status).not.toBe("FAIL");
    }
  });

  // Behavior changed 2026-08-30 and this assertion changed with it: a
  // bare literal match cannot prove the agent DID the forbidden thing.
  // The identical match is produced by grepping for the pattern, quoting
  // it, or naming it in a commit message. Independent testing found 19/19
  // remaining FAILs were exactly this confusion. UNCLEAR-with-evidence is
  // the honest answer; confident FAILs now come only from the structured
  // primitives that read what the agent actually executed or wrote.
  it("reports UNCLEAR, not FAIL, when the banned pattern appears — a match is not proof of an action", () => {
    const events = [toolUse("Bash", { command: "git push --force origin main" })];
    const [result] = runDeterministicChecks([rule], events);
    expect(result.status).toBe("UNCLEAR");
  });

  it("quotes the real matched text as evidence so a human can judge it", () => {
    const events = [toolUse("Bash", { command: "git push --force origin main" })];
    const [result] = runDeterministicChecks([rule], events);
    expect(result.evidence).toContain("git push --force");
    expect(result.evidence).toContain("needs a human look");
  });

  it("includes the actual matched text in the evidence, not a generic message", () => {
    const events = [toolUse("Bash", { command: "git push --force origin main" })];
    const [result] = runDeterministicChecks([rule], events);
    expect(result.evidence).toContain("git push --force");
  });

  it("PASSes when the pattern never appears", () => {
    const events = [toolUse("Bash", { command: "git push origin main" })];
    const [result] = runDeterministicChecks([rule], events);
    expect(result.status).toBe("PASS");
  });

  it("PASSes on a completely empty session (nothing to violate)", () => {
    const [result] = runDeterministicChecks([rule], []);
    expect(result.status).toBe("PASS");
  });

  it("checks non-Bash tool calls too, not just Bash", () => {
    const events = [toolUse("Write", { content: "run: git push --force later" })];
    const [result] = runDeterministicChecks([rule], events);
    expect(result.status).toBe("UNCLEAR");
  });

  // this is the exact false-positive that failed before the word-boundary
  // fix in deterministicChecks.ts — "--force-with-lease" is the SAFE
  // variant and must not be flagged as the banned bare "--force"
  it("does NOT false-positive on --force-with-lease, the safe variant", () => {
    const events = [toolUse("Bash", { command: "git push --force-with-lease origin main" })];
    const [result] = runDeterministicChecks([rule], events);
    expect(result.status).toBe("PASS");
  });

  // Real bug found while building a security-focused CLAUDE.md template:
  // a pattern ending in punctuation (like a URL scheme) could never match
  // a real occurrence, because the old trailing word-boundary check
  // unconditionally required "not followed by a word character" — but a
  // real URL always has a domain (word characters) immediately after
  // "http://". Confirmed false-negative by hand before writing this fix.
  it("matches a pattern ending in punctuation even when real text follows immediately (http:// bug)", () => {
    const urlRule: DeterministicClassification = {
      kind: "deterministic",
      rule: { id: "11", title: "No plain HTTP", text: "Never use `http://`.", source: "project" },
      patterns: ["http://"],
      polarity: "forbid",
    };
    const events = [toolUse("Write", { content: 'const url = "http://api.example.com/data";' })];
    const [result] = runDeterministicChecks([urlRule], events);
    // the point of this test is that the pattern MATCHES at all (the old
    // bug made it unmatchable); a match now surfaces as UNCLEAR rather
    // than FAIL, per the action-vs-mention rule
    expect(result.status).toBe("UNCLEAR");
    expect(result.evidence).toContain("http://");
  });

  it("still applies the word-boundary check when the pattern ends in a word character (regression guard)", () => {
    // --force must still NOT match inside --force-with-lease, same as before
    const events = [toolUse("Bash", { command: "git push --force-with-lease origin main" })];
    const [result] = runDeterministicChecks([rule], events);
    expect(result.status).toBe("PASS");
  });

  // Security audit flagged that an extreme pattern length might crash
  // regex construction. Direct empirical test (not theory): even a
  // 200,000-char pattern must not crash the whole check, and must stay
  // fast — regardless of whether it throws or not, a bad pattern must
  // never take down every other rule in the report.
  describe("require polarity (new: previously every deterministic rule was forbid-only)", () => {
    const requireRule: DeterministicClassification = {
      kind: "deterministic",
      rule: { id: "20", title: "Must run tests", text: "Always run `npm test` before committing.", source: "project" },
      patterns: ["npm test"],
      polarity: "require",
    };

    it("PASSes when the required pattern actually appears", () => {
      const events = [toolUse("Bash", { command: "npm test" })];
      const [result] = runDeterministicChecks([requireRule], events);
      expect(result.status).toBe("PASS");
    });

    it("reports UNCLEAR, never a fabricated FAIL or PASS, when the required pattern never appears", () => {
      const events = [toolUse("Bash", { command: "git commit -m done" })];
      const [result] = runDeterministicChecks([requireRule], events);
      expect(result.status).toBe("UNCLEAR");
    });

    it("reports UNCLEAR on a completely empty session too (can't tell if it applied)", () => {
      const [result] = runDeterministicChecks([requireRule], []);
      expect(result.status).toBe("UNCLEAR");
    });
  });

  describe("tool_result content is never scanned (real false-positive found 2026-08-30)", () => {
    const noPrintRule: DeterministicClassification = {
      kind: "deterministic",
      rule: { id: "20", title: "No debug print statements", text: "Never leave a `print(` statement in committed code.", source: "project" },
      patterns: ["print("],
      polarity: "forbid",
    };

    it("does NOT fail when the pattern only appears in a tool_result (e.g. reading a file's contents), never in the agent's own command or writes", () => {
      // deliberately an innocuous command whose OWN input text doesn't
      // contain "print(" at all — only the simulated file content
      // returned in the tool_result does, which is the real scenario
      // being tested
      const events = [toolUse("Read", { file_path: "src/legacy.py" }), toolResult("def f():\n    print('debug value:', x)\n")];
      const [result] = runDeterministicChecks([noPrintRule], events);
      expect(result.status).toBe("PASS");
    });

    it("surfaces the match when the pattern appears in what the agent actually wrote (tool_use input)", () => {
      const events = [toolUse("Write", { file_path: "src/new.py", content: "print('debug')" })];
      const [result] = runDeterministicChecks([noPrintRule], events);
      expect(result.status).toBe("UNCLEAR");
      expect(result.evidence).toContain("print(");
    });

    it("does NOT fail a require-polarity rule just because the required text appeared in read-only tool_result content", () => {
      const closesRule: DeterministicClassification = {
        kind: "deterministic",
        rule: { id: "21", title: "PR must close an issue", text: "Always include `Closes #N` in the PR description.", source: "project" },
        patterns: ["Closes #N"],
        polarity: "require",
      };
      // the agent merely READ a template file containing this text, never
      // wrote it into an actual PR body
      const events = [toolResult("PR_TEMPLATE.md contents: ## Description\nCloses #N\n")];
      const [result] = runDeterministicChecks([closesRule], events);
      expect(result.status).toBe("UNCLEAR");
    });
  });

  it("does not crash and stays fast on a pathologically long rule pattern", () => {
    const hugePattern = "a".repeat(200_000);
    const hugeRule: DeterministicClassification = {
      kind: "deterministic",
      rule: { id: "99", title: "Extreme pattern", text: `Never do \`${hugePattern}\`.`, source: "project" },
      patterns: [hugePattern],
      polarity: "forbid",
    };
    const start = Date.now();
    const [result] = runDeterministicChecks([hugeRule], [toolUse("Bash", { command: "echo hi" })]);
    const elapsedMs = Date.now() - start;
    expect(["PASS", "UNCLEAR"]).toContain(result.status);
    expect(elapsedMs).toBeLessThan(1000);
  });
});
