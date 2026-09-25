import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { partitionByAge, sessionStartTime } from "../src/ruleAge.js";
import { parseClaudeMdText } from "../src/parsers/claudeMdParser.js";
import type { TranscriptEvent } from "../src/types.js";

/**
 * From etoryoki on anthropics/claude-code#2544: a session cannot break a rule
 * added after it ran. This builds a real git history — rule A committed early,
 * rule B added later — and checks a session dated between the two.
 */
const RULE_A = "## 1. Never touch the ledger\nNever run `rm` on `data/ledger.db`.\n";
const RULE_B = "## 2. Never force push\nNever run `git push --force`.\n";
const at = (iso: string): TranscriptEvent => ({ role: "assistant", kind: "text", text: "x", timestamp: iso });

let dir: string;
function git(args: string[], date?: string) {
  const env = date ? { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : process.env;
  execFileSync("git", ["-C", dir, ...args], { env, stdio: "ignore" });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rr-age-"));
  git(["init"]);
  git(["config", "user.email", "t@t.t"]);
  git(["config", "user.name", "t"]);
  writeFileSync(join(dir, "CLAUDE.md"), `# Rules\n\n${RULE_A}`);
  git(["add", "CLAUDE.md"]);
  git(["commit", "-m", "add rule A"], "2026-01-01T00:00:00");
  writeFileSync(join(dir, "CLAUDE.md"), `# Rules\n\n${RULE_A}\n${RULE_B}`);
  git(["add", "CLAUDE.md"]);
  git(["commit", "-m", "add rule B"], "2026-06-01T00:00:00");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const currentRules = () => parseClaudeMdText(`# Rules\n\n${RULE_A}\n${RULE_B}`, "project");

describe("partitionByAge", () => {
  it("marks a rule added AFTER the session as future (not checked)", () => {
    const { present, future } = partitionByAge(dir, currentRules(), [at("2026-03-01T12:00:00Z")]);
    expect(present.map((r) => r.title)).toContain("Never touch the ledger");
    expect(future.map((r) => r.title)).toEqual(["Never force push"]);
  });

  it("checks both rules for a session that ran after both were added", () => {
    const { future } = partitionByAge(dir, currentRules(), [at("2026-09-01T12:00:00Z")]);
    expect(future).toEqual([]);
  });

  it("fails open (nothing filtered) outside a git repo", () => {
    const plain = mkdtempSync(join(tmpdir(), "rr-age-nogit-"));
    try {
      const { present, future } = partitionByAge(plain, currentRules(), [at("2026-03-01T12:00:00Z")]);
      expect(future).toEqual([]);
      expect(present).toHaveLength(currentRules().length);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it("fails open when the session has no timestamps", () => {
    const { future } = partitionByAge(dir, currentRules(), [{ role: "assistant", kind: "text", text: "x", timestamp: "" }]);
    expect(future).toEqual([]);
  });
});

describe("sessionStartTime", () => {
  it("returns the earliest timestamp", () => {
    expect(sessionStartTime([at("2026-03-02T00:00:00Z"), at("2026-03-01T00:00:00Z")])).toBe("2026-03-01T00:00:00Z");
  });
  it("returns null when nothing is timestamped", () => {
    expect(sessionStartTime([{ role: "user", kind: "text", text: "x", timestamp: "" }])).toBeNull();
  });
});
