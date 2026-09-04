import { describe, it, expect } from "vitest";
import { correlate, summarise, distinctiveTokens, isBlockingEvent } from "../src/checks/hookCoverage.js";
import type { Rule } from "../src/types.js";
import type { HookEntry } from "../src/checks/doctor.js";

/**
 * The question these tests protect: which rules have something behind them,
 * and — just as importantly — the tool never claiming more than it knows.
 *
 * The failure mode to guard against is a confident-looking link built from a
 * word both texts happen to contain. That is the same mistake as a text match
 * reporting a violation, one level up, and it would be worse here because the
 * output reads like an audit.
 */

function rule(title: string, text = ""): Rule {
  return { id: "1", title, text, source: "project" };
}
function hook(event: string, command: string, matcher?: string): HookEntry {
  return { sourceFile: ".claude/settings.json", event, command, flags: [], matcher };
}

describe("isBlockingEvent", () => {
  it("counts events that can refuse, and only those", () => {
    expect(isBlockingEvent("PreToolUse")).toBe(true);
    expect(isBlockingEvent("Stop")).toBe(true);
    // Runs after the call already succeeded, so it cannot make a rule fail.
    expect(isBlockingEvent("PostToolUse")).toBe(false);
    expect(isBlockingEvent("SessionStart")).toBe(false);
    expect(isBlockingEvent("InstructionsLoaded")).toBe(false);
  });
});

describe("distinctiveTokens", () => {
  it("picks up backtick-quoted commands and paths", () => {
    const t = distinctiveTokens("Never run `git push --force` on `main`.");
    expect(t).toContain("git push --force");
  });

  it("picks up bare flags and paths", () => {
    const t = distinctiveTokens("Do not edit files under vendor/generated or pass --no-verify.");
    expect(t.some((x) => x.includes("vendor/generated"))).toBe(true);
    expect(t).toContain("--no-verify");
  });

  it("drops words too common to mean anything", () => {
    // Linking a rule to a hook because both say "test" produces confident
    // nonsense. Better to report no link than a wrong one.
    const t = distinctiveTokens("Always write a `test` when you change `code`.");
    expect(t).not.toContain("test");
    expect(t).not.toContain("code");
  });

  it("drops tokens too short to be distinctive", () => {
    expect(distinctiveTokens("Use `rm` carefully.")).not.toContain("rm");
  });
});

describe("correlate", () => {
  it("links a rule to a blocking hook that names the same command", () => {
    const rules = [rule("Never force push", "Never run `git push --force`.")];
    const hooks = [hook("PreToolUse", "/usr/local/bin/guard.sh --deny 'git push --force'", "Bash")];
    const [c] = correlate(rules, hooks);
    expect(c.backing).toBe("possiblyGuarded");
    expect(c.sharedTokens).toContain("git push --force");
  });

  it("ignores hooks on events that cannot refuse anything", () => {
    // A SessionStart hook mentioning the same command does not make the rule
    // fail loudly when ignored, which is the whole question.
    const rules = [rule("Never force push", "Never run `git push --force`.")];
    const hooks = [hook("SessionStart", "echo 'git push --force is banned'")];
    const [c] = correlate(rules, hooks);
    expect(c.backing).toBe("noHookFound");
  });

  it("does not link on a common word shared by chance", () => {
    const rules = [rule("Write tests", "Always write a test for new code.")];
    const hooks = [hook("PreToolUse", "/opt/hooks/test-something.sh", "Bash")];
    const [c] = correlate(rules, hooks);
    expect(c.backing).toBe("noHookFound");
  });

  it("reports which token caused the link, so a wrong one is visible", () => {
    const rules = [rule("Vendor dir", "Do not edit files under vendor/generated.")];
    const hooks = [hook("PreToolUse", "/opt/hooks/block.sh vendor/generated", "Edit")];
    const [c] = correlate(rules, hooks);
    expect(c.sharedTokens.some((t) => t.includes("vendor/generated"))).toBe(true);
    expect(c.matchedHooks).toHaveLength(1);
  });

  it("leaves a judgment rule unbacked, because nothing names it", () => {
    const rules = [rule("Surface bad news first", "Lead with what is broken.")];
    const hooks = [hook("PreToolUse", "/opt/hooks/guard.sh", "Bash")];
    const [c] = correlate(rules, hooks);
    expect(c.backing).toBe("noHookFound");
  });

  it("reports nothing as guarded when there are no hooks at all", () => {
    const rules = [rule("Never force push", "Never run `git push --force`.")];
    const coverage = correlate(rules, []);
    expect(coverage.every((c) => c.backing === "noHookFound")).toBe(true);
  });
});

describe("summarise", () => {
  it("counts blocking and non-blocking hooks separately", () => {
    const rules = [rule("Never force push", "Never run `git push --force`.")];
    const hooks = [
      hook("PreToolUse", "/opt/guard.sh 'git push --force'", "Bash"),
      hook("SessionStart", "/opt/inject.sh"),
      hook("PostToolUse", "/opt/log.sh"),
    ];
    const s = summarise(correlate(rules, hooks), hooks);
    expect(s.blockingHooks).toBe(1);
    expect(s.nonBlockingHooks).toBe(2);
    expect(s.possiblyGuarded).toBe(1);
    expect(s.noHookFound).toBe(0);
    expect(s.totalRules).toBe(1);
  });
});
