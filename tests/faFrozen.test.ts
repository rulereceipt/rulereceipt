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
 * It surfaced a real false accusation — codeContent firing on a token MENTIONED in a
 * comment ("// never use console.log(") — which is now FIXED (codeContent strips
 * comments/strings before matching). The set keeps that case so the fix can't regress.
 * The regression case (0.1.88 future-read) must also stay at 0.
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

  it("raises ZERO false accusations on the hard set (the codeContent comment-mention gap is fixed)", () => {
    const all = fails();
    expect(all.length, `v2 false accusations:\n${all.join("\n")}`).toBe(0);
  });
});

/**
 * fa-corpus-v5 — the plain-prose branch-rule false accusations, locked PAIRWISE.
 * These are the exact cases that pulled Feature B from 0.1.111: a prose "never
 * push to main" path that dropped qualifiers ("force-push", "push secrets"),
 * crossed clauses (mixed polarity), followed the wrong verb (merge rules),
 * captured figurative objects ("push blame"), or the wrong token ("or"), and so
 * hard-FAILed an ordinary push. A plain push ban and a successful push-to-main
 * cannot coexist in a 0-FAIL cross-product (that pair is a real violation), so
 * each rule is paired with the specific session that makes it a near-miss.
 * See EXPECTATIONS.md. A miss is acceptable here; a false FAIL is not.
 */
describe("false-accusation frozen benchmark (fa-corpus-v5, plain-prose branch rules)", () => {
  const V5 = join(__dirname, "fixtures", "fa-corpus-v5");
  const run = (rule: string, session: string): CheckResult[] =>
    check(join(V5, "rules", rule), readTranscriptFromFile(join(V5, "sessions", session)));
  const fails = (rule: string, session: string): string[] =>
    run(rule, session).filter((r) => r.status === "FAIL").map((r) => r.evidence.slice(0, 100));

  // (rule, session) pairs that are near-misses — a correct checker stays quiet.
  const NOFAIL: [string, string][] = [
    ["force-push.md", "s-push-main.jsonl"],
    ["merge-prs.md", "s-push-main.jsonl"],
    ["push-secrets.md", "s-push-main.jsonl"],
    ["mixed-polarity.md", "s-push-main.jsonl"],
    ["merge-hotfix.md", "s-push-hotfix.jsonl"],
    ["push-blame.md", "s-push-main.jsonl"],
    ["incomplete-features.md", "s-push-main.jsonl"],
    ["main-or-trunk.md", "s-local-commit.jsonl"],
    ["commit-to-main.md", "s-push-main.jsonl"],
    ["clean-pushban.md", "s-failed-push-main.jsonl"],
    ["clean-pushban.md", "s-main-word.jsonl"],
    ["clean-pushban.md", "s-feature-push.jsonl"],
    ["clean-pushban.md", "s-commit-msg-push.jsonl"],
    ["clean-pushban.md", "s-local-commit.jsonl"],
    ["ordinary-main.md", "s-push-main.jsonl"],
  ];

  // (rule, session) pairs that MUST FAIL — the detection really fires (teeth).
  const MUSTFAIL: [string, string][] = [
    ["clean-pushban.md", "s-push-main.jsonl"],
    ["clean-pushban.md", "s-pushmain-id-unrelated-error.jsonl"],
  ];

  it("raises ZERO false accusations on any locked near-miss pair", () => {
    const bad: string[] = [];
    for (const [rule, session] of NOFAIL) {
      const f = fails(rule, session);
      if (f.length) bad.push(`${rule} x ${session}: ${f.join(" | ")}`);
    }
    expect(bad, `v5 false accusations:\n${bad.join("\n")}`).toEqual([]);
  });

  it("still FAILs on a real violation (the set is not vacuous)", () => {
    const missed: string[] = [];
    for (const [rule, session] of MUSTFAIL) {
      if (fails(rule, session).length === 0) missed.push(`${rule} x ${session}`);
    }
    expect(missed, `v5 missed real violations:\n${missed.join("\n")}`).toEqual([]);
  });
});
