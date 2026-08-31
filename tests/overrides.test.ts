import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadOverrides, resolveOverrides } from "../src/overrides.js";
import { generateReport } from "../src/report/generateReport.js";
import { generateHtmlReport } from "../src/report/generateHtmlReport.js";
import type { CheckResult } from "../src/types.js";

const CLI = resolve(__dirname, "..", "dist", "cli.js");

/**
 * The whole point of this suite: an override must never be usable to make
 * a real violation disappear.
 *
 * The unsafe version of this feature — let the user mark a rule as
 * not-a-rule and skip it — cannot be made safe by restricting which
 * direction the override moves, because deleting the question deletes the
 * failure with it. So these tests attack the feature the way someone
 * trying to fake a clean report would.
 */

let dir: string;
let emptyHome: string;

function overrideFile(entries: unknown) {
  writeFileSync(join(dir, ".rulereceipt.json"), JSON.stringify({ overrides: entries }, null, 2));
}

/**
 * Runs with an EMPTY HOME so the developer's own global CLAUDE.md can't
 * leak into the fixture. Without this the suite passes or fails depending
 * on whose machine it runs on — the exact hazard that has bitten this
 * project twice, and the one that surfaced the rule-id collision handled
 * below.
 */
function run(args: string[]): { out: string; code: number } {
  const env = { ...process.env, HOME: emptyHome, USERPROFILE: emptyHome };
  try {
    return { out: execFileSync("node", [CLI, ...args], { cwd: dir, env, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }), code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { out: `${e.stdout ?? ""}${e.stderr ?? ""}`, code: e.status ?? -1 };
  }
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "rr-override-"));
  emptyHome = mkdtempSync(join(tmpdir(), "rr-override-home-"));
  writeFileSync(
    join(dir, "CLAUDE.md"),
    "# Rules\n\n## 1. No console.log\nNever leave a `console.log(` call in committed code.\n"
  );
  // a session that genuinely breaks rule 1
  writeFileSync(
    join(dir, "violation.jsonl"),
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", name: "Write", input: { file_path: "a.ts", content: "console.log(1)" } }] },
    })
  );
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(emptyHome, { recursive: true, force: true });
});

describe("an override can never hide a real violation", () => {
  it("the violation is still reported, and still says NOT FOLLOWED", () => {
    overrideFile([{ rule: "1", reason: "legacy section, no longer applies", date: "2026-08-31" }]);
    const { out } = run(["check", "--transcript", "violation.jsonl"]);
    expect(out).toContain("FAIL");
    expect(out).toContain("No console.log");
  });

  it("the exit code STILL fails, so CI cannot be the loophole", () => {
    overrideFile([{ rule: "1", reason: "legacy section, no longer applies" }]);
    const { code } = run(["check", "--transcript", "violation.jsonl"]);
    expect(code).toBe(1);
  });

  it("the report states plainly that the override does not change the result", () => {
    overrideFile([{ rule: "1", reason: "legacy section, no longer applies" }]);
    const { out } = run(["check", "--transcript", "violation.jsonl"]);
    expect(out).toContain("USER-OVERRIDDEN");
    expect(out).toContain("The override does not change that.");
  });

  it("the summary line names the overridden failure instead of absorbing it", () => {
    overrideFile([{ rule: "1", reason: "legacy section, no longer applies" }]);
    const { out } = run(["check", "--transcript", "violation.jsonl"]);
    expect(out).toMatch(/1 user-overridden \(1 still not followed\)/);
  });

  it("the HTML report's headline verdict still reports the violation", () => {
    const overridden: CheckResult = {
      ruleId: "1", ruleTitle: "No console.log", ruleSource: "project",
      status: "FAIL", evidence: "wrote console.log(1)",
      overriddenReason: "legacy section", overriddenDate: "2026-08-31",
    };
    const html = generateHtmlReport([overridden], {
      sessionFilePath: null, ruleCount: 1, projectPath: "/p",
      generatedAt: new Date("2026-08-31"), toolVersion: "0",
    });
    expect(html).toContain("1 rule not followed");
    expect(html).toContain(`<div class="verdict verdict--fail">`);
  });

  it("the HTML report shows the reason AND what the result would have been", () => {
    const overridden: CheckResult = {
      ruleId: "1", ruleTitle: "No console.log", ruleSource: "project",
      status: "FAIL", evidence: "wrote console.log(1)",
      overriddenReason: "legacy section", overriddenDate: "2026-08-31",
    };
    const html = generateHtmlReport([overridden], {
      sessionFilePath: null, ruleCount: 1, projectPath: "/p",
      generatedAt: new Date("2026-08-31"), toolVersion: "0",
    });
    expect(html).toContain("legacy section");
    expect(html).toContain("Without this override, the result is:");
    expect(html).toContain("Not followed");
  });

  it("an override never mutates the computed status", () => {
    const results: CheckResult[] = [{
      ruleId: "1", ruleTitle: "r", ruleSource: "project",
      status: "FAIL", evidence: "e", overriddenReason: "because",
    }];
    const out = generateReport(results, { sessionFilePath: null, ruleCount: 1 });
    expect(results[0].status).toBe("FAIL");
    expect(out).toContain("FAIL");
  });
});

describe("overrides fail closed", () => {
  it("refuses an override with no reason, and says why", () => {
    overrideFile([{ rule: "1" }]);
    const { out } = run(["check", "--transcript", "violation.jsonl"]);
    expect(out).toContain("no \"reason\" given");
    expect(out).not.toContain("USER-OVERRIDDEN");
  });

  it("refuses an override whose reason is only whitespace", () => {
    const { byRuleId, problems } = loadOverridesIn([{ rule: "1", reason: "   " }]);
    expect(byRuleId.size).toBe(0);
    expect(problems.join(" ")).toContain("reason");
  });

  it("a malformed file disables overrides but never breaks the check", () => {
    writeFileSync(join(dir, ".rulereceipt.json"), "{ not json");
    const { out, code } = run(["check", "--transcript", "violation.jsonl"]);
    expect(out).toContain("isn't valid JSON");
    expect(out).toContain("FAIL"); // the check still ran
    expect(code).toBe(1);
  });

  it("ignores an entry with no rule id", () => {
    const { byRuleId, problems } = loadOverridesIn([{ reason: "no id given" }]);
    expect(byRuleId.size).toBe(0);
    expect(problems.join(" ")).toContain("rule");
  });

  it("no override file at all is simply no overrides", () => {
    const empty = mkdtempSync(join(tmpdir(), "rr-override-none-"));
    try {
      const { byRuleId, problems } = loadOverrides(empty);
      expect(byRuleId.size).toBe(0);
      expect(problems).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("the intended use still works", () => {
  it("labels a misclassified rule while keeping its real result visible", () => {
    overrideFile([{ rule: "1", reason: "this heading is a changelog entry, not a rule", date: "2026-08-31" }]);
    const { out } = run(["check", "--transcript", "violation.jsonl"]);
    expect(out).toContain("this heading is a changelog entry, not a rule");
    expect(out).toContain("2026-08-31");
  });
});

/** Writes an override file into a scratch dir and loads it. */
function loadOverridesIn(entries: unknown) {
  const d = mkdtempSync(join(tmpdir(), "rr-override-load-"));
  try {
    writeFileSync(join(d, ".rulereceipt.json"), JSON.stringify({ overrides: entries }));
    return loadOverrides(d);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

// keeps the import used even if assertions above change
void readFileSync;

/**
 * Rule ids are not unique across sources: a global CLAUDE.md and a
 * project one can both define "Rule 1", which the report already
 * disambiguates on collision. Found while running this feature's own
 * tests on a real machine — a bare id silently overrode BOTH rules,
 * including one the user never intended to touch.
 */
describe("an ambiguous rule id is refused rather than guessed", () => {
  it("does not apply a bare id that exists in two sources, and says how to fix it", () => {
    const loaded = { byRuleId: new Map([["1", { rule: "1", reason: "because" }]]), problems: [] };
    const { bySourceAndId, problems } = resolveOverrides(loaded, [
      { ruleId: "1", ruleSource: "global" },
      { ruleId: "1", ruleSource: "project" },
    ]);
    expect(bySourceAndId.size).toBe(0);
    expect(problems.join(" ")).toContain("exists in BOTH");
    expect(problems.join(" ")).toContain('"project:1"');
  });

  it("applies a bare id when only one rule has it", () => {
    const loaded = { byRuleId: new Map([["1", { rule: "1", reason: "because" }]]), problems: [] };
    const { bySourceAndId } = resolveOverrides(loaded, [{ ruleId: "1", ruleSource: "project" }]);
    expect(bySourceAndId.get("project:1")?.reason).toBe("because");
  });

  it("applies a scoped id to exactly one source, never both", () => {
    const loaded = { byRuleId: new Map([["project:1", { rule: "project:1", reason: "because" }]]), problems: [] };
    const { bySourceAndId } = resolveOverrides(loaded, [
      { ruleId: "1", ruleSource: "global" },
      { ruleId: "1", ruleSource: "project" },
    ]);
    expect(bySourceAndId.size).toBe(1);
    expect(bySourceAndId.has("project:1")).toBe(true);
    expect(bySourceAndId.has("global:1")).toBe(false);
  });

  it("reports an override that matches no rule at all, instead of failing silently", () => {
    const loaded = { byRuleId: new Map([["999", { rule: "999", reason: "because" }]]), problems: [] };
    const { bySourceAndId, problems } = resolveOverrides(loaded, [{ ruleId: "1", ruleSource: "project" }]);
    expect(bySourceAndId.size).toBe(0);
    expect(problems.join(" ")).toContain("did nothing");
  });
});
