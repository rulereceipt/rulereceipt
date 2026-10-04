import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { parseClaudeMd } from "../src/parsers/readClaudeMd.js";
import { readTranscriptFromFile } from "../src/parsers/transcriptParser.js";
import { classifyRules } from "../src/checks/classify.js";
import { runDeterministicChecks } from "../src/checks/deterministicChecks.js";
import { runIfEditThenTestChecks } from "../src/checks/ifEditThenTest.js";
import { runGitBranchPolicyChecks } from "../src/checks/gitBranchPolicy.js";
import { runCodeContentChecks } from "../src/checks/codeContent.js";
import { runFileLifecycleChecks } from "../src/checks/fileLifecycle.js";
import { runClaimEvidenceChecks } from "../src/checks/claimEvidence.js";
import type { CheckResult, TranscriptEvent } from "../src/types.js";

/**
 * The FROZEN false-accusation benchmark (fa-corpus-v1): the number that only
 * moves when the checkers change. The sessions are realistic NEAR-MISSES — a
 * push to a feature branch, `.env.example`, a grep that mentions `console.log(`,
 * a backed "tests pass" claim, the prescribed merge, a future plan — on which a
 * correct tool raises ZERO false accusations. This test IS the published-number
 * guard: if a checker regresses to over-accuse, one near-miss flips to FAIL and
 * this fails. (That the checkers actually engage is proven elsewhere — a push to
 * `main` FAILs; these near-misses must stay quiet.)
 */
const DIR = join(__dirname, "fixtures", "fa-corpus-v1");
function check(rulesFile: string, events: TranscriptEvent[]): CheckResult[] {
  const cls = classifyRules(parseClaudeMd(rulesFile, "project"));
  const of = (k: string) => cls.filter((c) => c.kind === k) as never;
  return [
    ...runDeterministicChecks(of("deterministic"), events),
    ...runIfEditThenTestChecks(of("ifEditThenTest"), events),
    ...runGitBranchPolicyChecks(of("gitBranchPolicy"), events),
    ...runCodeContentChecks(of("codeContent"), events),
    ...runFileLifecycleChecks(of("fileLifecycle"), events),
    ...runClaimEvidenceChecks(of("claimEvidence"), events),
  ];
}

describe("false-accusation frozen benchmark (fa-corpus-v1)", () => {
  const ruleFiles = readdirSync(join(DIR, "rules")).filter((f) => f.endsWith(".md")).sort();
  const sessionFiles = readdirSync(join(DIR, "sessions")).filter((f) => f.endsWith(".jsonl")).sort();
  const sessions = sessionFiles.map((f) => readTranscriptFromFile(join(DIR, "sessions", f)));

  it("has a stable, versioned shape (12 rules x 6 sessions)", () => {
    expect(ruleFiles.length).toBe(12);
    expect(sessionFiles.length).toBe(6);
  });

  it("raises ZERO false accusations across the whole set", () => {
    const fails: string[] = [];
    for (const rf of ruleFiles) {
      for (let i = 0; i < sessions.length; i++) {
        for (const r of check(join(DIR, "rules", rf), sessions[i])) {
          if (r.status === "FAIL") fails.push(`${rf} x ${sessionFiles[i]}: ${r.evidence.slice(0, 80)}`);
        }
      }
    }
    expect(fails, `false accusations on near-misses:\n${fails.join("\n")}`).toEqual([]);
  });
});

/**
 * fa-corpus-v2 — HARD cases, and we KEEP the ones we fail, so this number is honest.
 * Current known gap: codeContent fires on a token MENTIONED in a comment (not a real
 * call). That one false accusation is pinned here as a baseline; when codeContent learns
 * to ignore comment mentions, drop the expectation to 0. The regression case (0.1.88
 * future-read) must stay at 0 — that one is fixed and must never come back.
 */
describe("false-accusation frozen benchmark (fa-corpus-v2, hard cases)", () => {
  const V2 = join(__dirname, "fixtures", "fa-corpus-v2");
  const ruleFiles = readdirSync(join(V2, "rules")).filter((f) => f.endsWith(".md")).sort();
  const sessionFiles = readdirSync(join(V2, "sessions")).filter((f) => f.endsWith(".jsonl")).sort();
  const sessions = sessionFiles.map((f) => readTranscriptFromFile(join(V2, "sessions", f)));
  const fails = (): string[] => {
    const out: string[] = [];
    for (const rf of ruleFiles) for (let i = 0; i < sessions.length; i++)
      for (const r of check(join(V2, "rules", rf), sessions[i]))
        if (r.status === "FAIL") out.push(`${rf} x ${sessionFiles[i]}: ${r.evidence.slice(0, 80)}`);
    return out;
  };

  it("never false-accuses on the 0.1.88 future-read regression case", () => {
    const regressionFails = fails().filter((f) => f.includes("regression-future-read"));
    expect(regressionFails, regressionFails.join("\n")).toEqual([]);
  });

  it("pins the known-gap count (1: codeContent fires on a comment mention) — drop to 0 when fixed", () => {
    const all = fails();
    expect(all.length, `v2 false accusations:\n${all.join("\n")}`).toBe(1);
    expect(all[0]).toMatch(/comment-mention/);
    expect(all[0]).toMatch(/console\.log\(/);
  });
});
