import { describe, it, expect } from "vitest";
import { classifyRule } from "../src/checks/classify.js";
import { runAttributionChecks } from "../src/checks/attribution.js";
import type { AttributionClassification } from "../src/checks/classify.js";
import type { TranscriptEvent } from "../src/types.js";

/**
 * "No AI attribution in commits" is checkable, and was routing to judgment.
 *
 * From anthropics/claude-code#83813, #92169, #82690 and #4287: a user forbids
 * `Co-Authored-By: Claude` / "Generated with Claude Code" in their rules
 * file, and the trailer lands on the commit anyway. One of the most-filed
 * rule-following complaints, and mechanically checkable — the trailer is
 * literal text sitting in the git command the assistant ran.
 *
 * Scope is kept as narrow as the emoji check: only a git-writing command the
 * ASSISTANT issued is inspected, never rule text, user text, or a plain file
 * read — because a rule that forbids the trailer necessarily quotes it, and
 * this repo's own CLAUDE.md does exactly that.
 */
const rule = (text: string, title = "Attribution") =>
  ({ id: "1", title, text, source: "project" as const });
const cls = (text: string) =>
  [{ kind: "attribution", rule: rule(text), polarity: "forbid" }] as unknown as AttributionClassification[];
const bash = (command: string): TranscriptEvent => ({
  role: "assistant",
  kind: "tool_use",
  toolName: "Bash",
  input: { command },
  timestamp: "t",
});
const says = (text: string): TranscriptEvent => ({ role: "assistant", kind: "text", text, timestamp: "t" });

const FORBID_RULE =
  "no AI trace in git commits, PRs, or GitHub comments. Never add `Co-Authored-By: Claude`.";

describe("attribution rules route to the attribution check", () => {
  for (const t of [
    FORBID_RULE,
    "Never add Co-Authored-By: Claude to a commit.",
    "Do not include 'Generated with Claude Code' in any pull request.",
    "Commits must never carry AI attribution: do not add a Co-Authored-By trailer to any git commit.",
  ]) {
    it(`routes: ${t.slice(0, 40)}`, () => expect(classifyRule(rule(t)).kind).toBe("attribution"));
  }

  it("does not route a rule that PRESCRIBES attribution of third-party code", () => {
    expect(classifyRule(rule("Always add proper attribution to third-party code snippets you copy.")).kind)
      .not.toBe("attribution");
  });

  it("does not route a benign product mention of Claude Code", () => {
    expect(classifyRule(rule("The README should explain that the product checks Claude Code sessions.")).kind)
      .not.toBe("attribution");
  });
});

describe("attribution violations are caught from the git command, honestly scoped", () => {
  it("fails on a Co-Authored-By trailer in a commit", () => {
    const [r] = runAttributionChecks(cls(FORBID_RULE), [
      bash('git commit -m "fix parser" -m "Co-Authored-By: Claude <noreply@anthropic.com>"'),
    ]);
    expect(r.status).toBe("FAIL");
    expect(r.evidence).toContain("Co-Authored-By");
    expect(r.method).toBe("attribution_scan");
  });

  it("fails on a 'Generated with Claude Code' line in a PR body", () => {
    const [r] = runAttributionChecks(cls(FORBID_RULE), [
      bash('gh pr create --title x --body "Adds a badge\n\n🤖 Generated with Claude Code"'),
    ]);
    expect(r.status).toBe("FAIL");
  });

  it("passes (pass) when a real commit carries no trailer", () => {
    const [r] = runAttributionChecks(cls(FORBID_RULE), [bash('git commit -m "fix the parser"')]);
    expect(r.status).not.toBe("FAIL");
    expect(r.outcome).toBe("pass");
  });

  it("is not_applicable when the session never wrote to git", () => {
    const [r] = runAttributionChecks(cls(FORBID_RULE), [bash("git status"), bash("npm test")]);
    expect(r.status).not.toBe("FAIL");
    expect(r.outcome).toBe("not_applicable");
  });

  it("does NOT fire on the trailer outside a git-writing command", () => {
    // The phrase is present, but it is being written to a notes file, not committed.
    const [r] = runAttributionChecks(cls(FORBID_RULE), [
      bash('echo "Co-Authored-By: Claude" >> scratch/notes.txt'),
    ]);
    expect(r.status).not.toBe("FAIL");
  });

  it("does NOT fire on the trailer appearing only in assistant text", () => {
    const [r] = runAttributionChecks(cls(FORBID_RULE), [
      says("I will not add Co-Authored-By: Claude to the commit, per the rule."),
      bash('git commit -m "fix"'),
    ]);
    expect(r.status).not.toBe("FAIL");
  });

  it("does NOT fire on a heredoc that WRITES a commit example (not runs it)", () => {
    const [r] = runAttributionChecks(cls(FORBID_RULE), [
      bash('cat > demo.md <<EOF\ngit commit -m "x" -m "Co-Authored-By: Claude"\nEOF'),
    ]);
    expect(r.status).not.toBe("FAIL");
  });

  it("catches a commit with config flags between 'git' and 'commit'", () => {
    const [r] = runAttributionChecks(cls(FORBID_RULE), [
      bash('git -c user.name=x commit -m "Co-Authored-By: Claude <noreply@anthropic.com>"'),
    ]);
    expect(r.status).toBe("FAIL");
  });

  it("STILL catches a real heredoc that FEEDS the commit message the trailer", () => {
    const [r] = runAttributionChecks(cls(FORBID_RULE), [
      bash('git commit -F- <<EOF\nfix the parser\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nEOF'),
    ]);
    expect(r.status).toBe("FAIL");
  });
});
