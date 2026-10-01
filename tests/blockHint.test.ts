import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blockHintFor } from "../src/blockHint.js";
import { classifyRule } from "../src/checks/classify.js";
import { loadRules } from "../src/rules.js";
import type { Rule } from "../src/types.js";

/**
 * blockHint must never promise more than the guard delivers. Each test pins the
 * advice to what guardDecision/structuredBlocks actually do (see guard.ts): the
 * guard blocks a branch, a file, forbidden file content and an AI-authorship
 * trailer before the run, answers "ask" for an approval gate, and does NOT touch
 * anything else. A native permission rule is only offered where one can genuinely
 * express the rule, always with its honest limitation.
 */

/**
 * Classify the single rule in a one-rule CLAUDE.md, the way `why` reaches it.
 * HOME is redirected to an empty dir so the machine's own global
 * ~/.claude/CLAUDE.md can't leak its rules in and break the one-rule assumption.
 */
function classifyOne(body: string) {
  const dir = mkdtempSync(join(tmpdir(), "rr-bh-"));
  const home = mkdtempSync(join(tmpdir(), "rr-bh-home-"));
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  const prevConfig = process.env.CLAUDE_CONFIG_DIR;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.CLAUDE_CONFIG_DIR;
  try {
    writeFileSync(join(dir, "CLAUDE.md"), body);
    const rules = loadRules(dir);
    expect(rules.length).toBe(1);
    return classifyRule(rules[0]);
  } finally {
    process.env.HOME = prevHome;
    if (prevProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevProfile;
    if (prevConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prevConfig;
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

describe("blockHintFor — never promises more than the guard delivers", () => {
  it("a branch forbid is preventable, guard-covered, with a coarse native deny that can't scope to the branch", () => {
    const cls = classifyOne("## 1. Branch\nNever push to the `main` branch directly.\n");
    expect(cls.kind).toBe("gitBranchPolicy");
    const h = blockHintFor(cls)!;
    expect(h.preventable).toBe(true);
    expect(h.guardCovers).toBe(true);
    expect(h.native!.kind).toBe("deny");
    expect(h.native!.entries).toContain("Bash(git push:*)");
    // The honest caveat must be present: a permission rule can't see the branch.
    expect(h.native!.note.toLowerCase()).toContain("branch");
  });

  it("a file forbid gets a precise native Edit/Write deny for that path", () => {
    const cls = classifyOne("## 1. Secrets\nNever modify `.env`.\n");
    expect(cls.kind).toBe("fileLifecycle");
    const h = blockHintFor(cls)!;
    expect(h.preventable).toBe(true);
    expect(h.guardCovers).toBe(true);
    expect(h.native!.kind).toBe("deny");
    expect(h.native!.entries).toEqual(["Edit(.env)", "Write(.env)"]);
  });

  it("an approval gate on push gets a native ask, with the no-prompt-mode caveat", () => {
    const cls = classifyOne("## 1. Push\nNever push without the user's explicit approval.\n");
    expect(cls.kind).toBe("approvalGate");
    const h = blockHintFor(cls)!;
    expect(h.preventable).toBe(true);
    expect(h.native!.kind).toBe("ask");
    expect(h.native!.entries).toContain("Bash(git push:*)");
    expect(h.native!.note.toLowerCase()).toMatch(/no-prompt|bypass/);
  });

  it("an attribution rule is guard-covered but has NO native rule (a permission can't read a commit message)", () => {
    const cls = classifyOne("## 1. No AI trace\nNever add a `Co-Authored-By: Claude` trailer to a git commit.\n");
    expect(cls.kind).toBe("attribution");
    const h = blockHintFor(cls)!;
    expect(h.preventable).toBe(true);
    expect(h.guardCovers).toBe(true);
    expect(h.native).toBeUndefined();
    expect(h.nativeImpossibleReason).toBeDefined();
  });

  it("a claim-evidence rule is NOT preventable — it is judged after the run", () => {
    const cls = classifyOne("## 1. Evidence\nNever report a task done without pasting the test output as proof.\n");
    expect(cls.kind).toBe("claimEvidence");
    const h = blockHintFor(cls)!;
    expect(h.preventable).toBe(false);
    expect(h.guardCovers).toBe(false);
  });

  it("a judgment rule yields no hint at all", () => {
    const cls = classifyOne("## 1. Quality\nWrite clean, elegant, maintainable code.\n");
    expect(cls.kind).toBe("judgment");
    expect(blockHintFor(cls)).toBeUndefined();
  });

  // Polarity edge: a REQUIRE branch/file rule has no single action to refuse
  // before the fact, so it must not be reported as preventable.
  it("a require-polarity structured rule is not preventable (built directly to pin the polarity branch)", () => {
    const rule: Rule = { id: "1", title: "Branch", text: "Always push to `release`.", source: "project" };
    const h = blockHintFor({ kind: "gitBranchPolicy", rule, branchName: "release", polarity: "require" })!;
    expect(h.preventable).toBe(false);
    expect(h.native).toBeUndefined();
  });
});
